/**
 * The merge has to be something two devices can each compute and agree on,
 * without a server refereeing. These are the cases that decide whether it does.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  IMPORTS_EPOCH, SHARED_SETTINGS, emptyState, mergeStates, packImport,
  photoNeeds, photoPath, photosToDownload,
} from '../src/lib/sync.js';

const doc = (uid, updated, extra = {}) => ({
  uid, member_uid: 'm1', type: 'passport', expiry_date: '2036-01-13',
  updated_at: updated, status: 'active', ...extra,
});
const state = (documents = [], tombstones = [], members = []) => ({
  ...emptyState(), documents, tombstones, members,
});

test('a document only the remote has comes down', () => {
  const { merged, incoming } = mergeStates(state(), state([doc('d1', '2026-08-01')]));
  assert.equal(merged.documents.length, 1);
  assert.equal(incoming.documents.length, 1);
});

test('a document only this device has is kept, and the remote is stale', () => {
  const { merged, incoming, remoteIsStale } = mergeStates(state([doc('d1', '2026-08-01')]), state());
  assert.equal(merged.documents.length, 1);
  assert.equal(incoming.documents.length, 0);
  assert.equal(remoteIsStale, true);
});

test('the newer edit wins, whichever side made it', () => {
  const older = doc('d1', '2026-08-01', { number: 'OLD' });
  const newer = doc('d1', '2026-08-02', { number: 'NEW' });

  assert.equal(mergeStates(state([older]), state([newer])).merged.documents[0].number, 'NEW');
  assert.equal(mergeStates(state([newer]), state([older])).merged.documents[0].number, 'NEW');
});

test('a deletion is not undone by the other device still holding the record', () => {
  const { merged } = mergeStates(
    state([], [{ uid: 'd1', kind: 'document', deleted_at: '2026-08-05' }]),
    state([doc('d1', '2026-08-01')]),
  );
  assert.equal(merged.documents.length, 0);
  assert.equal(merged.tombstones.length, 1);
});

test('an edit made after the deletion brings the record back', () => {
  // Deleted on the phone, then re-added and corrected on the laptop. The later
  // intent is the one that counts.
  const { merged } = mergeStates(
    state([], [{ uid: 'd1', kind: 'document', deleted_at: '2026-08-05' }]),
    state([doc('d1', '2026-08-09')]),
  );
  assert.equal(merged.documents.length, 1);
});

test('merging is symmetric — both devices reach the same answer', () => {
  const a = state([doc('d1', '2026-08-02'), doc('d2', '2026-08-01')],
    [{ uid: 'd3', kind: 'document', deleted_at: '2026-08-04' }]);
  const b = state([doc('d1', '2026-08-01'), doc('d3', '2026-08-03')]);

  const forwards = mergeStates(a, b).merged;
  const backwards = mergeStates(b, a).merged;
  const uids = (s) => s.documents.map((d) => d.uid).sort();
  assert.deepEqual(uids(forwards), uids(backwards));
  assert.deepEqual(uids(forwards), ['d1', 'd2']);
});

test('merging twice changes nothing the second time', () => {
  const a = state([doc('d1', '2026-08-02')]);
  const b = state([doc('d2', '2026-08-01')]);
  const once = mergeStates(a, b).merged;
  const twice = mergeStates(once, once);
  assert.equal(twice.remoteIsStale, false);
  assert.equal(twice.incoming.documents.length, 0);
});

test('a malformed or empty remote file does not lose local data', () => {
  for (const broken of [null, undefined, {}, { documents: 'nonsense' }]) {
    const { merged } = mergeStates(state([doc('d1', '2026-08-01')]), broken);
    assert.equal(merged.documents.length, 1);
  }
});

test('photos are only fetched for documents this device lacks', () => {
  const mergedDocs = [
    { uid: 'd1', has_photo: true, photo_bytes: 10 },
    { uid: 'd2', has_photo: true, photo_bytes: 10 },
    { uid: 'd3', has_photo: false },
  ];
  const local = [{ uid: 'd1', photo: { size: 10 } }];
  assert.deepEqual(photosToDownload(mergedDocs, local).map((d) => d.uid), ['d2']);
});

test('a photo replaced elsewhere is fetched again, and only that side', () => {
  const record = { uid: 'd1', has_photo: true, photo_bytes: 900, has_back: true, photo_back_bytes: 400 };
  const unchanged = photoNeeds(record, { photo: { size: 900 }, photo_back: { size: 400 } });
  assert.deepEqual(unchanged, { front: false, back: false });

  const reshot = photoNeeds(record, { photo: { size: 120 }, photo_back: { size: 400 } });
  assert.deepEqual(reshot, { front: true, back: false }, 'the untouched back is left where it is');

  const backOnly = photoNeeds(record, { photo: { size: 900 }, photo_back: null });
  assert.deepEqual(backOnly, { front: false, back: true });
});

test('photo filenames follow the document, and keep the right extension', () => {
  assert.equal(photoPath('abc', 'image/jpeg'), 'photos/abc.jpg');
  assert.equal(photoPath('abc', 'application/pdf'), 'photos/abc.pdf');
  assert.equal(photoPath('abc', 'image/png'), 'photos/abc.png');
  assert.equal(photoPath('abc', 'image/jpeg', 'back'), 'photos/abc-back.jpg');
  // The byte count in the name is what makes a replacement a different file.
  assert.equal(photoPath('abc', 'image/jpeg', 'front', 2048), 'photos/abc-2048.jpg');
  assert.equal(photoPath('abc', 'image/jpeg', 'back', 2048), 'photos/abc-back-2048.jpg');
});

test('a device without the photo yet cannot say the photo is gone', () => {
  // Same record, same timestamp: one side holds the picture, the other has only
  // just pulled the record. The merge must not conclude there is no picture.
  const withPhoto = doc('d1', '2026-08-01', { has_photo: true, has_back: true, photo_type: 'image/jpeg' });
  const notYet = doc('d1', '2026-08-01', { has_photo: false, has_back: false, photo_type: 'image/jpeg' });

  for (const [local, remote] of [[notYet, withPhoto], [withPhoto, notYet]]) {
    const { merged } = mergeStates(state([local]), state([remote]));
    assert.equal(merged.documents[0].has_photo, true);
    assert.equal(merged.documents[0].has_back, true);
  }
});

test('a later edit on a device without the photo still does not drop it', () => {
  const remote = doc('d1', '2026-08-01', { has_photo: true, photo_type: 'image/jpeg' });
  const local = doc('d1', '2026-08-09', { has_photo: false, number: 'CORRECTED' });

  const { merged, remoteIsStale } = mergeStates(state([local]), state([remote]));
  assert.equal(merged.documents[0].number, 'CORRECTED');
  assert.equal(merged.documents[0].has_photo, true);
  assert.equal(merged.documents[0].photo_type, 'image/jpeg', 'the path to the photo survives too');
  assert.equal(remoteIsStale, true);
});

test('correcting the photo flag alone is enough to rewrite the remote file', () => {
  const local = doc('d1', '2026-08-01', { has_photo: true });
  const remote = doc('d1', '2026-08-01', { has_photo: false });
  assert.equal(mergeStates(state([local]), state([remote])).remoteIsStale, true);
});

test('the newer record decides which picture is the current one', () => {
  // Re-photographed on the phone: the laptop's copy is the old one, and the
  // laptop must not put it back over the top.
  const phone = doc('d1', '2026-08-09', { has_photo: true, photo_bytes: 5000, photo_type: 'image/jpeg' });
  const laptop = doc('d1', '2026-08-01', { has_photo: true, photo_bytes: 900, photo_type: 'image/jpeg' });

  const { merged } = mergeStates(state([laptop]), state([phone]));
  assert.equal(merged.documents[0].photo_bytes, 5000);
  assert.deepEqual(photoNeeds(merged.documents[0], { photo: { size: 900 } }), { front: true, back: false });
});

// ----------------------------------------------- the settings the household shares

const withSettings = (rows) => ({ ...emptyState(), settings: rows });
const setting = (key, value, at) => ({ key, value, updated_at: at });

test('a reminder rule set on the phone reaches the laptop', () => {
  const phone = withSettings([setting('reminder_rules', { overdueRepeat: 30 }, '2026-08-02T00:00:00Z')]);
  const laptop = withSettings([setting('reminder_rules', { overdueRepeat: 7 }, '2026-08-01T00:00:00Z')]);
  const { merged, incoming } = mergeStates(laptop, phone);
  assert.deepEqual(merged.settings[0].value, { overdueRepeat: 30 });
  assert.equal(incoming.settings.length, 1, 'the laptop has something to apply');
});

test('the newer answer wins whichever device holds it', () => {
  const older = withSettings([setting('reminder_rules', 'old', '2026-08-01T00:00:00Z')]);
  const newer = withSettings([setting('reminder_rules', 'new', '2026-08-09T00:00:00Z')]);
  assert.equal(mergeStates(newer, older).merged.settings[0].value, 'new');
  assert.equal(mergeStates(older, newer).merged.settings[0].value, 'new');
});

test('a setting written before stamps existed loses to one that has a stamp', () => {
  const unstamped = withSettings([{ key: 'reminder_rules', value: 'ancient' }]);
  const stamped = withSettings([setting('reminder_rules', 'current', '2026-08-09T00:00:00Z')]);
  assert.equal(mergeStates(unstamped, stamped).merged.settings[0].value, 'current');
});

test('the API key is never carried into the cloud file', () => {
  assert.ok(!SHARED_SETTINGS.includes('anthropic_api_key'));
  assert.ok(!SHARED_SETTINGS.includes('onedrive_client_id'));
  const local = withSettings([
    setting('anthropic_api_key', 'sk-ant-secret', '2026-08-09T00:00:00Z'),
    setting('reminder_rules', 'fine', '2026-08-09T00:00:00Z'),
  ]);
  const { merged } = mergeStates(local, emptyState());
  assert.deepEqual(merged.settings.map((r) => r.key), ['reminder_rules']);
  assert.ok(!JSON.stringify(merged).includes('sk-ant-secret'));
});

test('an unknown setting is not carried either, even from the cloud', () => {
  const remote = withSettings([setting('something_new', 'value', '2026-08-09T00:00:00Z')]);
  assert.deepEqual(mergeStates(emptyState(), remote).merged.settings, []);
});

// ---------------------------------------- the log of what has been read already

const entry = (id, at, extra = {}) => ({
  item_id: id, c_tag: 'c-' + id, name: id + '.jpg', path: '/' + id + '.jpg',
  document_uid: 'd-' + id, outcome: 'filed', imported_at: at, ...extra,
});
const withImports = (rows, settings = []) => ({ ...emptyState(), imports: rows, settings });

test('the second device is told which files have already been read', () => {
  const laptop = withImports([entry('f1', '2026-08-01T00:00:00Z')]);
  const phone = withImports([entry('f2', '2026-08-02T00:00:00Z')]);
  const { merged, incoming } = mergeStates(laptop, phone);
  assert.deepEqual(merged.imports.map((r) => r.item_id).sort(), ['f1', 'f2']);
  assert.deepEqual(incoming.imports.map((r) => r.item_id), ['f2']);
});

test('a file re-read after being replaced carries the newer cTag', () => {
  const laptop = withImports([entry('f1', '2026-08-01T00:00:00Z', { c_tag: 'old' })]);
  const phone = withImports([entry('f1', '2026-08-05T00:00:00Z', { c_tag: 'new' })]);
  assert.equal(mergeStates(laptop, phone).merged.imports[0].c_tag, 'new');
});

test('clearing everything really clears the log, on both devices', () => {
  // The phone still holds the whole log; the laptop cleared it a moment ago.
  const cleared = '2026-08-10T00:00:00Z';
  const laptop = withImports([], [setting(IMPORTS_EPOCH, cleared, cleared)]);
  const phone = withImports([entry('f1', '2026-08-01T00:00:00Z'), entry('f2', '2026-08-02T00:00:00Z')]);
  const { merged, incoming, remoteIsStale } = mergeStates(laptop, phone);
  assert.deepEqual(merged.imports, [], 'nothing older than the reset survives');
  assert.deepEqual(incoming.imports, [], 'and nothing is handed back to the laptop');
  assert.ok(remoteIsStale, 'the cloud copy has to be rewritten without them');
});

test('a file read after the reset is kept', () => {
  const cleared = '2026-08-10T00:00:00Z';
  const laptop = withImports(
    [entry('f3', '2026-08-11T00:00:00Z')],
    [setting(IMPORTS_EPOCH, cleared, cleared)],
  );
  const phone = withImports([entry('f1', '2026-08-01T00:00:00Z')]);
  assert.deepEqual(mergeStates(laptop, phone).merged.imports.map((r) => r.item_id), ['f3']);
});

test('the log points at documents by uid, never by a local row id', () => {
  const packed = packImport(
    { item_id: 'f1', c_tag: 'c1', name: 'a.jpg', path: '/a.jpg', document_id: 7, outcome: 'filed', imported_at: 'x' },
    new Map([[7, 'doc-uid-7']]),
  );
  assert.equal(packed.document_uid, 'doc-uid-7');
  assert.ok(!('document_id' in packed), 'a local id means nothing on the other device');
});

test('a log entry for a document this device never had points at nothing', () => {
  const packed = packImport({ item_id: 'f1', document_id: 99, imported_at: 'x' }, new Map());
  assert.equal(packed.document_uid, null);
});
