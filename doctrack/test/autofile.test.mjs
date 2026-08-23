/**
 * Automatic filing decisions, tested without a browser. Dexie needs IndexedDB,
 * so db-backed paths are covered in the Playwright run; these cover the pure
 * decision logic that decides whether a document is safe to file unattended.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { memberNamedIn, reviewReasons } from '../src/lib/autofile.js';
import { validateDocument } from '../src/lib/validate.js';
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

// ------------------------------------- finding a known person in a filename

const household = [
  { id: 1, name: 'Raouf Andrea' },
  { id: 2, name: 'Sandy Charif' },
  { id: 3, name: 'Lily Charalambous' },
  { id: 4, name: 'Andreas Charalambous' },
  { id: 5, name: 'Bella' },
];

test('a filename that names someone on file is filed under them', () => {
  assert.equal(memberNamedIn('Raouf Andrea Driving Licence 2035', household)?.id, 1);
  assert.equal(memberNamedIn('sandy charif passport', household)?.id, 2);
  assert.equal(memberNamedIn('Bella vaccination 2027', household)?.id, 5);
});

test('a filename that names nobody on file matches nobody', () => {
  assert.equal(memberNamedIn('Passport 2035', household), null);
  assert.equal(memberNamedIn('Mohammed Hassan Emirates ID', household), null);
  assert.equal(memberNamedIn('', household), null);
});

test('half a name is not the person', () => {
  // "Charalambous" alone is two people's surname and neither one's whole name.
  assert.equal(memberNamedIn('Charalambous passport', household), null);
});

test('the fuller name wins when one contains the other', () => {
  const both = [{ id: 1, name: 'Andreas' }, { id: 2, name: 'Andreas Charalambous' }];
  assert.equal(memberNamedIn('Andreas Charalambous Passport', both)?.id, 2);
  assert.equal(memberNamedIn('Andreas Passport', both)?.id, 1);
});

test('a genuine tie is left unanswered rather than guessed', () => {
  const twins = [{ id: 1, name: 'Lily' }, { id: 2, name: 'Lily' }];
  assert.equal(memberNamedIn('Lily Passport', twins), null);
});

test('a one-letter member name cannot swallow every file', () => {
  assert.equal(memberNamedIn('A Passport 2030', [{ id: 1, name: 'A' }]), null);
});

test('the name has to be whole words, not a fragment', () => {
  assert.equal(memberNamedIn('Lilypad Insurance', [{ id: 1, name: 'Lily' }]), null);
});

// ------------------------- confirming a document that could never remind you

test('checking a document refuses a blank date rather than trapping it', () => {
  const form = { member_id: 1, type: 'passport', label: '', expiry_date: '', no_expiry: 0 };
  assert.deepEqual(validateDocument(form), {}, 'an ordinary edit is allowed to leave it blank');
  assert.match(
    validateDocument(form, { requireRemindable: true }).expiry_date ?? '',
    /does not expire/,
    'but confirming it in the review run has to say why it cannot be accepted',
  );
});

test('"does not expire" is the other way to satisfy it', () => {
  const form = { member_id: 1, type: 'birth_certificate', expiry_date: '', no_expiry: 1 };
  assert.deepEqual(validateDocument(form, { requireRemindable: true }), {});
});

test('a date is the obvious way to satisfy it', () => {
  const form = { member_id: 1, type: 'passport', expiry_date: '2031-01-01', no_expiry: 0 };
  assert.deepEqual(validateDocument(form, { requireRemindable: true }), {});
});
