/**
 * Reading a household's own filing. Every case here is taken from a real
 * OneDrive tree rather than invented, including the awkward ones.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { looksLikePortrait, pairingKey, readDocumentType, readPath, readPersonFromName, readSide, readYear } from '../src/lib/filename.js';

const TODAY = new Date('2026-08-22T12:00:00');
const at = (path) => readPath(path, { today: TODAY });

test('the folder a document sits in names its owner', () => {
  assert.equal(at("Familly Documents & ID's/Andy/Andreas EID.pdf").person, 'Andy');
  assert.equal(at("Familly Documents & ID's/Lily Charalambous/Lily EID 2036.pdf").person, 'Lily Charalambous');
  assert.equal(at("Familly Documents & ID's/Sandy Charif/Sandy EID.pdf").person, 'Sandy Charif');
});

test('a folder that groups by kind is not a person', () => {
  // "Cyprus ID's" says what the documents are, not whose they are — and the
  // collection folder above it is nobody either.
  assert.equal(at("Familly Documents & ID's/Cyprus ID's/somebody.jpg").person, null);
  assert.equal(at("Golden Visa Files/scan.pdf").person, null);
});

test('a category folder inside a person’s folder still names the person', () => {
  assert.equal(
    at("Familly Documents & ID's/Raouf Andrea/Passports/Raouf Passport 2036.jpg").person,
    'Raouf Andrea',
  );
});

test('a person inside a group folder carries the relation too', () => {
  const maid = at("Familly Documents & ID's/Maids/Maria Santos/Maria Passport 2029.pdf");
  assert.equal(maid.person, 'Maria Santos');
  assert.equal(maid.relation, 'Housemaid');

  const pet = at('Pets/Bella/Bella Vaccine Report 2027.pdf');
  assert.equal(pet.person, 'Bella');
  assert.equal(pet.relation, 'Pet');
});

test('the group folder itself never becomes a person', () => {
  assert.equal(at('Maids/some loose file.pdf').person, null);
  assert.equal(at('Pets/vaccines.pdf').person, null);
});

test('an Expired folder marks the documents, not their owner', () => {
  const old = at("Familly Documents & ID's/Raouf Andrea/Expired/Raouf Passport 2021.pdf");
  assert.equal(old.archived, true);
  assert.equal(old.person, 'Raouf Andrea');

  assert.equal(at("Familly Documents & ID's/Raouf Andrea/Raouf Passport 2036.pdf").archived, false);
});

test('a bare filename with no folder yields no owner', () => {
  assert.equal(at('Raouf Passport 2036.jpg').person, null);
});

// --- the year in the name ---------------------------------------------------

test('the expiry year is read from the filename', () => {
  assert.equal(readYear('Raouf Passport 2036', { today: TODAY }), 2036);
  assert.equal(readYear('Lily EID 2036', { today: TODAY }), 2036);
  assert.equal(readYear('Sandy Passport Cyprus 2033', { today: TODAY }), 2033);
  assert.equal(readYear('Raouf - Egypt Passport 2029', { today: TODAY }), 2029);
});

test('a year long past is a birth year or a scan date, not an expiry', () => {
  assert.equal(readYear('Andy Birth Certificate 1998', { today: TODAY }), null);
  assert.equal(readYear('CamScanner 14-04-2026 19.02', { today: TODAY }), 2026);
});

test('a name with no year gives none', () => {
  assert.equal(readYear('Marriage Certificate Arabic', { today: TODAY }), null);
  assert.equal(readYear('توكيل عام', { today: TODAY }), null);
});

test('the last plausible year wins, since numbers appear elsewhere', () => {
  assert.equal(readYear('Policy 2024 renewed to 2027', { today: TODAY }), 2027);
});

// --- two-sided cards --------------------------------------------------------

test('front and back are recognised and paired', () => {
  assert.equal(readSide('EID 2032 Front'), 'front');
  assert.equal(readSide('EID 2032 Back'), 'back');
  assert.equal(readSide('Raouf EID 2032'), null);
  assert.equal(pairingKey('EID 2032 Front'), pairingKey('EID 2032 Back'));
});

test('different cards do not pair', () => {
  assert.notEqual(pairingKey('Raouf EID Front'), pairingKey('Sandy EID Front'));
});

// --- portraits --------------------------------------------------------------

test('a passport photo is recognised as not a document', () => {
  for (const name of ['Raouf Personal Photo', 'Sandy Personal Photo', 'Andy personal Photo',
    'Photo', 'IMG_1746', 'DSC_0042']) {
    assert.equal(looksLikePortrait(name), true, `${name} should read as a portrait`);
  }
});

test('a real document is never mistaken for a photo', () => {
  for (const name of ['Raouf Passport 2036', 'Lily Birth Certificate Arabic', 'Sandy EID',
    'Photo ID Card 2030', 'Andreas Golden Visa']) {
    assert.equal(looksLikePortrait(name), false, `${name} should read as a document`);
  }
});

// --- how the filing rules use all of this -----------------------------------

import { pairSides } from '../src/lib/filename.js';
import { reviewReasons } from '../src/lib/autofile.js';
import { normaliseExtraction } from '../src/lib/extract.js';

const entry = (path) => ({ file: { name: path.split('/').pop() }, hints: at(path) });

test('a front and back of the same card become one upload', () => {
  const entries = [
    entry("Familly Documents & ID's/Raouf Andrea/EID 2032 Front.jpg"),
    entry("Familly Documents & ID's/Raouf Andrea/EID 2032 Back.jpg"),
    entry("Familly Documents & ID's/Raouf Andrea/Raouf Passport 2036.jpg"),
  ];
  const paired = pairSides(entries);
  assert.equal(paired.length, 2);
  assert.ok(paired.find((e) => e.backFile), 'the front should carry the back with it');
});

test('two different cards photographed front and back stay separate', () => {
  const paired = pairSides([
    entry("Familly Documents & ID's/Raouf Andrea/Raouf EID Front.jpg"),
    entry("Familly Documents & ID's/Raouf Andrea/Raouf EID Back.jpg"),
    entry("Familly Documents & ID's/Sandy Charif/Sandy EID Front.jpg"),
    entry("Familly Documents & ID's/Sandy Charif/Sandy EID Back.jpg"),
  ]);
  assert.equal(paired.length, 2);
});

test('a lone back with no matching front is still filed', () => {
  const paired = pairSides([entry("Familly Documents & ID's/Andy/Andreas EID Back.jpg")]);
  assert.equal(paired.length, 1);
});

const read = (over = {}) =>
  normaliseExtraction({
    document_type: 'passport', holder_name_guess: 'Raouf Charalambous',
    id_number_guess: 'L00393196', label_guess: '', issue_date: '2026-01-13',
    expiry_date: '2036-01-13', confidence: 0.95,
    field_confidence: { document_type: 0.97, holder_name_guess: 0.92, id_number_guess: 0.97,
      issue_date: 0.9, expiry_date: 0.97 },
    warnings: [], ...over,
  });

test('a filename year agreeing with the document raises nothing', () => {
  assert.deepEqual(reviewReasons(read(), { type: 'passport', filenameYear: 2036 }), []);
});

test('a filename year contradicting the document is flagged', () => {
  const reasons = reviewReasons(read(), { type: 'passport', filenameYear: 2031 });
  assert.equal(reasons.length, 1);
  assert.match(reasons[0], /2036.*2031|2031.*2036/);
});

test('a missing expiry names the year the filename offers', () => {
  const reasons = reviewReasons(read({ expiry_date: '' }), { type: 'passport', filenameYear: 2036 });
  assert.match(reasons[0], /filename says 2036/);
});

test('a document that never expires is not asked for a date', () => {
  assert.deepEqual(
    reviewReasons(read({ expiry_date: '', document_type: 'birth_certificate' }),
      { type: 'birth_certificate' }),
    [],
  );
});

test('the chosen folder itself is not mistaken for a person', () => {
  // A loose file inside a category folder at the top of the tree belongs to
  // nobody in particular — the collection's own name is not a person.
  assert.equal(at("Familly Documents & ID's/Cyprus ID's/loose scan.jpg").person, null);
});

test('but picking one person’s folder still names them', () => {
  // Here the chosen root IS the person, because the document sits in it.
  assert.equal(at('Raouf Andrea/Raouf Passport 2036.jpg').person, 'Raouf Andrea');
});

test('the filename names the document kind, typos and all', () => {
  const cases = {
    'Lily Birth ceritificate English': 'birth_certificate',
    'New Digital Birth Certificate6788098253517130371': 'birth_certificate',
    'Marriage Certificate English Attested': 'marriage_certificate',
    'Power Of Attorney from Ali to Raouf': 'power_of_attorney',
    'توكيل عام': 'power_of_attorney',
    'Raouf Andrea University Certificate': 'education_certificate',
    'Bella Vaccine Report 2027': 'vaccination',
    'Lily Visa 2036': 'residency_visa',
    'Raouf Golden Visa 2032': 'residency_visa',
    'Lily EID 2036': 'emirates_id',
    'Lily Cyprus ID': 'cyprus_id',
    'Lily Cyprus Passport 2031': 'passport',
    'Car License': 'vehicle_registration',
    'Driving License': 'driving_license',
    'Insurance Card': 'health_insurance',
  };
  for (const [name, expected] of Object.entries(cases)) {
    assert.equal(readDocumentType(name), expected, `${name} should read as ${expected}`);
  }
});

test('a filename that says nothing about the kind leaves it to the reader', () => {
  assert.equal(readDocumentType('CamScanner 14-04-2026 19.02'), null);
  assert.equal(readDocumentType('IMG_1746'), null);
  assert.equal(readDocumentType('scan001'), null);
});

test('a passport is not read out of a birth certificate that merely quotes one', () => {
  // "Father Passport No" appears on every UAE birth certificate.
  assert.equal(readDocumentType('Lily Birth Certificate Arabic'), 'birth_certificate');
});

// -------------------------------------------------- a person in the filename

test('a filename says who it belongs to when no folder does', () => {
  assert.equal(readPersonFromName('Raouf Andrea Driving Licence 2035'), 'Raouf Andrea');
  assert.equal(readPersonFromName('Sandy Charif Passport'), 'Sandy Charif');
  assert.equal(readPersonFromName('Lily Emirates ID 2030 front'), 'Lily');
  assert.equal(readPersonFromName('Bella vaccination record'), 'Bella');
});

test('filing noise is not mistaken for a name', () => {
  assert.equal(readPersonFromName('Passport 2035'), null);
  assert.equal(readPersonFromName('Emirates ID copy'), null);
  assert.equal(readPersonFromName('scan 001'), null);
  assert.equal(readPersonFromName('IMG_20240103'), null);
  assert.equal(readPersonFromName(''), null);
  assert.equal(readPersonFromName(null), null);
});

test('a sentence is not a name', () => {
  assert.equal(
    readPersonFromName('please find attached herewith the renewed papers for review'),
    null,
  );
});

test('initials alone are not enough to name anyone', () => {
  assert.equal(readPersonFromName('A B Passport'), null);
  assert.equal(readPersonFromName('R C Emirates ID 2031'), null);
});

test('a guessed name is only offered when the folder is silent', () => {
  const fromFolder = readPath('Raouf Andrea/Sandy Charif Passport 2035.jpg');
  assert.equal(fromFolder.person, 'Raouf Andrea');
  assert.equal(fromFolder.personGuess, null, 'the folder already answered');

  const loose = readPath('Sandy Charif Passport 2035.jpg');
  assert.equal(loose.person, null);
  assert.equal(loose.personGuess, 'Sandy Charif');
});
