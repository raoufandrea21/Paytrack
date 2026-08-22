/**
 * Automatic filing decisions, tested without a browser. Dexie needs IndexedDB,
 * so db-backed paths are covered in the Playwright run; these cover the pure
 * decision logic that decides whether a document is safe to file unattended.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewReasons } from '../src/lib/autofile.js';
import { matchMemberByName } from '../src/db.js';
import { normaliseExtraction } from '../src/lib/extract.js';
import { buildExtractionRequest, PDF_MEDIA_TYPE } from '../shared/extraction-spec.js';

const read = (over = {}, conf = {}) =>
  normaliseExtraction({
    document_type: 'passport',
    holder_name_guess: 'Fatima Al Mansoori',
    id_number_guess: 'A1234567',
    issue_date: '2021-04-02',
    expiry_date: '2031-04-01',
    confidence: 0.93,
    field_confidence: {
      document_type: 0.98, holder_name_guess: 0.94, id_number_guess: 0.95,
      issue_date: 0.9, expiry_date: 0.96, ...conf,
    },
    warnings: [],
    ...over,
  });

test('a clean read files itself with nothing to ask', () => {
  assert.deepEqual(reviewReasons(read()), []);
});

test('a missing expiry date always earns a review — reminders depend on it', () => {
  const reasons = reviewReasons(read({ expiry_date: '' }));
  assert.equal(reasons.length, 1);
  assert.match(reasons[0], /reminders will not fire/);
});

test('a shaky expiry date earns a review even though it was read', () => {
  const reasons = reviewReasons(read({}, { expiry_date: 0.4 }));
  assert.ok(reasons.some((r) => /hard to read/.test(r)));
});

test('an unrecognised document type earns a review', () => {
  assert.ok(reviewReasons(read({ document_type: '' })).some((r) => /type/.test(r)));
});

test('an unidentifiable holder earns a review', () => {
  const reasons = reviewReasons(read(), { holderUncertain: true });
  assert.ok(reasons.some((r) => /whose document/.test(r)));
});

test('model warnings are carried through to the review reasons', () => {
  const reasons = reviewReasons(read({ warnings: ['Glare across the card.'] }));
  assert.deepEqual(reasons, ['Glare across the card.']);
});

test('a low-confidence number is worth checking but does not block filing', () => {
  const reasons = reviewReasons(read({}, { id_number_guess: 0.3 }));
  assert.equal(reasons.length, 1);
  assert.match(reasons[0], /number/);
});

// --- who a document belongs to ---------------------------------------------

const members = [
  { id: 1, name: 'Fatima Al Mansoori' },
  { id: 2, name: 'Omar Haddad' },
  { id: 3, name: 'Omar Al Sayed' },
];

test('an exact name matches, whatever the punctuation and case', () => {
  assert.equal(matchMemberByName('fatima al  mansoori', members).id, 1);
  assert.equal(matchMemberByName('FATIMA AL MANSOORI.', members).id, 1);
});

test('a unique first name matches', () => {
  assert.equal(matchMemberByName('Fatima', members).id, 1);
});

test('an ambiguous first name matches nobody rather than guessing', () => {
  assert.equal(matchMemberByName('Omar', members), null);
});

test('an unknown name matches nobody', () => {
  assert.equal(matchMemberByName('Layla Haddad', members), null);
  assert.equal(matchMemberByName('', members), null);
  assert.equal(matchMemberByName(null, members), null);
});

test('Arabic-script names survive normalisation', () => {
  const arabic = [{ id: 9, name: 'فاطمة المنصوري' }];
  assert.equal(matchMemberByName('فاطمة المنصوري', arabic).id, 9);
});

// --- PDFs -------------------------------------------------------------------

test('a PDF is sent as a document block, not an image block', () => {
  const body = buildExtractionRequest({ imageBase64: 'AAAA', mediaType: PDF_MEDIA_TYPE });
  assert.equal(body.messages[0].content[0].type, 'document');
  assert.equal(body.messages[0].content[0].source.media_type, 'application/pdf');
});

test('a photo is still sent as an image block', () => {
  const body = buildExtractionRequest({ imageBase64: 'AAAA', mediaType: 'image/png' });
  assert.equal(body.messages[0].content[0].type, 'image');
});
