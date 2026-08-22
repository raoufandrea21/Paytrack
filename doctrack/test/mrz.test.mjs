/**
 * MRZ parsing. These cases are the OCR failure modes seen on a real photographed
 * passport, not hypotheticals: the filler '<' comes back as a guillemet, as a
 * letter, or missing entirely, and O/0 confusion runs through the number field.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkDigit, findMrzLines, readMrz } from '../src/lib/mrz.js';
import { parseDocumentText } from '../src/lib/localread.js';

const NAMES = 'P<CYPCHARALAMBOUS<<RAOUF<<<<<<<<<<<<<<<<<<<<';
const DATA = 'L003931968CYP8903107M3601132<<<<<<<<<<<<<<02';

test('check digits follow the 7-3-1 weighting', () => {
  assert.equal(checkDigit('L00393196'), 8);
  assert.equal(checkDigit('890310'), 7);
  assert.equal(checkDigit('360113'), 2);
});

test('a clean passport MRZ yields every field, all checks agreeing', () => {
  const mrz = readMrz(`${NAMES}\n${DATA}`);
  assert.equal(mrz.isPassport, true);
  assert.equal(mrz.name, 'Raouf Charalambous');
  assert.equal(mrz.number, 'L00393196');
  assert.equal(mrz.dateOfBirth, '1989-03-10');
  assert.equal(mrz.expiryDate, '2036-01-13');
  assert.equal(mrz.nationality, 'Cypriot');
  assert.deepEqual(mrz.checks, { number: true, dateOfBirth: true, expiryDate: true });
});

test('the MRZ is found among the rest of the page', () => {
  const mrz = readMrz(`REPUBLIC OF CYPRUS\nPASSPORT\nnoise 12/34\n${NAMES}\n${DATA}\nfooter`);
  assert.equal(mrz.expiryDate, '2036-01-13');
});

test('detection survives the filler being eaten or misread', () => {
  for (const line1 of ['PPCYPCHARALAMBOUS RAOUF', 'P«CYPCHARALAMBOUS««RAOUF«««']) {
    const mrz = readMrz(`${line1}\n${DATA.replace(/</g, '«')}`);
    assert.ok(mrz, `no MRZ found for ${line1}`);
    assert.equal(mrz.expiryDate, '2036-01-13');
    assert.equal(mrz.number, 'L00393196');
  }
});

test('O read for zero is corrected, and the check digit confirms it', () => {
  const mrz = readMrz(`${NAMES}\n${DATA.replace('L003931968', 'LOO3931968')}`);
  assert.equal(mrz.number, 'L00393196');
  assert.equal(mrz.checks.number, true);
});

test('a genuine letter O in a number is left alone', () => {
  const number = 'O12345678';
  const line2 =
    number + checkDigit(number) + 'GBR800101' + checkDigit('800101')
    + 'M301225' + checkDigit('301225') + '<'.repeat(14) + '0';
  const mrz = readMrz(`P<GBRSMITH<<JOHN<<<<\n${line2}`);
  assert.equal(mrz.number, 'O12345678');
  assert.equal(mrz.checks.number, true);
});

test('filler misread as letters does not become part of the name', () => {
  const mrz = readMrz(`P<CYPCHARALAMBOUSKKGGGGGGRAOUF<<<<\n${DATA}`);
  assert.equal(mrz.name, null); // better nameless than "Kkgggggg"
  assert.equal(mrz.expiryDate, '2036-01-13');
});

test('a smudged expiry is reported as failing its check rather than trusted', () => {
  const mrz = readMrz(`${NAMES}\n${DATA.replace('3601132', '3601139')}`);
  assert.equal(mrz.checks.expiryDate, false);
});

test('ordinary text is not mistaken for an MRZ', () => {
  assert.equal(findMrzLines('Expiry Date: 13/01/2036\nName: Raouf'), null);
  assert.equal(readMrz(''), null);
});

// --- how the reader uses it -------------------------------------------------

test('the MRZ overrides what the decorated side of the page said', () => {
  const page = [
    'REPUBLIC OF CYPRUS',
    'PASSPORT',
    'Expires on (8)',
    '13/01/2026', // the issue date, in the position OCR often confuses
    NAMES,
    DATA,
  ].join('\n');
  const result = parseDocumentText(page, 60, readMrz(page));
  assert.equal(result.document_type, 'passport');
  assert.equal(result.expiry_date, '2036-01-13');
  assert.equal(result.id_number_guess, 'L00393196');
  assert.equal(result.holder_name_guess, 'Raouf Charalambous');
  assert.equal(result.label_guess, 'Cypriot');
  assert.ok(result.field_confidence.expiry_date > 0.9);
  assert.deepEqual(result.warnings, []);
});

test('a label and its value on separate lines still pair up', () => {
  const page = 'DRIVING LICENCE\nExpiry Date\n09/06/2032\nDate of Birth\n04/09/1990';
  const result = parseDocumentText(page, 80);
  assert.equal(result.expiry_date, '2032-06-09');
  assert.ok(result.field_confidence.expiry_date > 0.7);
});

test('a date of birth on its own line is never taken for an expiry', () => {
  const page = 'IDENTITY CARD\nDate of Birth\n04/09/1990';
  const result = parseDocumentText(page, 80);
  assert.equal(result.expiry_date, '');
});

test('OCR noise is not filed as a name or a document number', () => {
  const page = 'Onomata / Adi / Given Names (2)\nTaadigivennameszhuepcevv\nPassport No\n18AYVEIAT';
  const result = parseDocumentText(page, 55);
  assert.equal(result.holder_name_guess, '');
  assert.equal(result.id_number_guess, '');
});
