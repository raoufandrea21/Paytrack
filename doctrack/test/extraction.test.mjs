/**
 * Exercises the extraction pipeline without spending API calls: a stub server
 * stands in for api.anthropic.com so the real SDK, the real request body and the
 * real parsing all run.
 *
 *   node --test test/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import {
  buildExtractionRequest,
  parseExtractionResponse,
  EXTRACTION_MODEL,
  EXTRACTION_SCHEMA,
} from '../shared/extraction-spec.js';
import { normaliseExtraction } from '../src/lib/extract.js';
import { handleExtract } from '../api/_handler.js';
import {
  parseLooseDate, urgencyFor, shortRemaining, standingFor, daysUntil,
} from '../src/lib/dates.js';

const CLEAN_READ = {
  document_type: 'emirates_id',
  holder_name_guess: 'Fatima Al Mansoori',
  id_number_guess: '784-1988-1234567-1',
  issue_date: '2024-03-02',
  expiry_date: '2027-03-01',
  confidence: 0.94,
  field_confidence: {
    document_type: 0.99, holder_name_guess: 0.93, id_number_guess: 0.96,
    issue_date: 0.9, expiry_date: 0.95,
  },
  warnings: [],
};

function stubServer(handler) {
  const server = createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

test('request body carries the image, the model and the JSON schema', () => {
  const body = buildExtractionRequest({ imageBase64: 'AAAA', mediaType: 'image/jpeg' });
  assert.equal(body.model, EXTRACTION_MODEL);
  assert.equal(body.output_config.format.type, 'json_schema');
  assert.deepEqual(body.output_config.format.schema, EXTRACTION_SCHEMA);
  const [image, text] = body.messages[0].content;
  assert.equal(image.source.data, 'AAAA');
  assert.equal(image.source.media_type, 'image/jpeg');
  assert.equal(text.type, 'text');
});

test('parseExtractionResponse pulls JSON out of the text block', () => {
  const parsed = parseExtractionResponse({
    content: [{ type: 'text', text: JSON.stringify(CLEAN_READ) }],
  });
  assert.equal(parsed.expiry_date, '2027-03-01');
});

test('a clean read needs no review', () => {
  const result = normaliseExtraction(CLEAN_READ);
  assert.deepEqual(result.needsReview, []);
  assert.equal(result.fields.expiry_date.value, '2027-03-01');
  assert.equal(result.fields.type.value, 'emirates_id');
  assert.equal(result.model, EXTRACTION_MODEL);
});

test('blank and low-confidence fields are both flagged for review', () => {
  const result = normaliseExtraction({
    ...CLEAN_READ,
    holder_name_guess: '',
    field_confidence: { ...CLEAN_READ.field_confidence, holder_name_guess: 0, id_number_guess: 0.4 },
    warnings: ['Name is printed in Arabic only.'],
  });
  assert.equal(result.fields.holder_name.value, null);
  assert.ok(result.needsReview.includes('holder_name'));
  assert.ok(result.needsReview.includes('number'));
  assert.ok(!result.needsReview.includes('expiry_date'));
});

test('an unknown document type falls back to null rather than being trusted', () => {
  const result = normaliseExtraction({ ...CLEAN_READ, document_type: 'tax_card' });
  assert.equal(result.fields.type.value, null);
  assert.ok(result.needsReview.includes('type'));
});

test('a non-ISO date from the model is re-parsed, and ambiguity drops confidence', () => {
  const result = normaliseExtraction({
    ...CLEAN_READ,
    expiry_date: '03/04/2027',
    field_confidence: { ...CLEAN_READ.field_confidence, expiry_date: 0.95 },
  });
  assert.equal(result.fields.expiry_date.value, '2027-04-03');
  assert.ok(result.fields.expiry_date.confidence <= 0.5);
  assert.ok(result.needsReview.includes('expiry_date'));
  assert.ok(result.warnings.some((w) => w.includes('day/month')));
});

test('an unreadable date becomes blank plus a warning, never a guess', () => {
  const result = normaliseExtraction({ ...CLEAN_READ, expiry_date: '١٤٤٨ هـ' });
  assert.equal(result.fields.expiry_date.value, null);
  assert.ok(result.needsReview.includes('expiry_date'));
  assert.equal(result.warnings.length, 1);
});

test('Arabic-Indic digits parse to the same date as Western ones', () => {
  assert.equal(parseLooseDate('١٢/٠٥/٢٠٢٧').iso, '2027-05-12');
  assert.equal(parseLooseDate('12 مايو 2027').iso, '2027-05-12');
});

test('urgency bands match the spec: 7 / 30 / 60', () => {
  const today = new Date('2026-08-21T12:00:00');
  const at = (iso) => urgencyFor(iso, { today }).id;
  assert.equal(at('2026-08-01'), 'red');   // expired
  assert.equal(at('2026-08-28'), 'red');   // exactly 7 days
  assert.equal(at('2026-08-29'), 'amber'); // 8 days
  assert.equal(at('2026-09-20'), 'amber'); // exactly 30 days
  assert.equal(at('2026-09-21'), 'yellow');
  assert.equal(at('2026-10-20'), 'yellow'); // exactly 60 days
  assert.equal(at('2026-10-21'), 'green');
  assert.equal(at(''), 'unknown');
  assert.equal(daysUntil('2026-08-28', { today }), 7);
  assert.equal(shortRemaining('2026-08-21', { today }), 'Today');
});

test('the server handler round-trips through the real SDK', async () => {
  let seen = null;
  const { server, port } = await stubServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen = { url: req.url, key: req.headers['x-api-key'], body: JSON.parse(body) };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 'msg_test', type: 'message', role: 'assistant', model: EXTRACTION_MODEL,
        content: [{ type: 'text', text: JSON.stringify(CLEAN_READ) }],
        stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 },
      }));
    });
  });

  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`;
  try {
    const { status, body } = await handleExtract(
      { imageBase64: 'AAAA', mediaType: 'image/jpeg' },
      { apiKey: 'sk-ant-test' },
    );
    assert.equal(status, 200);
    assert.equal(body.expiry_date, '2027-03-01');
    assert.equal(seen.url, '/v1/messages');
    assert.equal(seen.key, 'sk-ant-test');
    assert.equal(seen.body.model, EXTRACTION_MODEL);
    assert.equal(seen.body.output_config.format.type, 'json_schema');
  } finally {
    server.close();
  }
});

test('the handler rejects bad input before it costs an API call', async () => {
  assert.equal((await handleExtract({}, { apiKey: 'k' })).status, 400);
  assert.equal(
    (await handleExtract({ imageBase64: 'A', mediaType: 'application/pdf' }, { apiKey: 'k' })).status,
    400,
  );
  assert.equal((await handleExtract({ imageBase64: 'A', mediaType: 'image/png' }, {})).status, 500);
});

// ------------------------------------- the three states the dashboard counts

test('out of date means out of date, not nearly', () => {
  const today = new Date('2026-08-22T09:00:00Z');
  const at = (date) => standingFor({ expiry_date: date }, { today });
  assert.equal(at('2026-08-21'), 'overdue');
  assert.equal(at('2026-08-22'), 'soon', 'today is the last day, not a day late');
  assert.equal(at('2026-08-23'), 'soon', 'tomorrow is urgent but it has not run out');
  assert.equal(at('2026-10-21'), 'soon', 'sixty days is the edge of "coming up"');
  assert.equal(at('2026-10-22'), 'fine');
});

test('a document that never expires is not something to do', () => {
  const today = new Date('2026-08-22T09:00:00Z');
  assert.equal(standingFor({ no_expiry: 1, expiry_date: '' }, { today }), 'fine');
  assert.equal(standingFor({ expiry_date: '' }, { today }), 'fine');
});

test('an overdue chip says how overdue', () => {
  const today = new Date('2026-08-22T09:00:00Z');
  assert.equal(shortRemaining('2026-08-19', { today }), '3d ago');
  assert.equal(shortRemaining('2026-02-22', { today }), '6mo ago');
  assert.equal(shortRemaining('2023-08-22', { today }), '3y ago');
  assert.equal(shortRemaining('2026-08-25', { today }), '3d');
});
