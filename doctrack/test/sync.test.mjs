/**
 * The merge has to be something two devices can each compute and agree on,
 * without a server refereeing. These are the cases that decide whether it does.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyState, mergeStates, photoPath, photosToDownload } from '../src/lib/sync.js';

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
    { uid: 'd1', has_photo: true },
    { uid: 'd2', has_photo: true },
    { uid: 'd3', has_photo: false },
  ];
  const local = [{ uid: 'd1', photo: {} }];
  assert.deepEqual(photosToDownload(mergedDocs, local).map((d) => d.uid), ['d2']);
});

test('photo filenames follow the document, and keep the right extension', () => {
  assert.equal(photoPath('abc', 'image/jpeg'), 'photos/abc.jpg');
  assert.equal(photoPath('abc', 'application/pdf'), 'photos/abc.pdf');
  assert.equal(photoPath('abc', 'image/png'), 'photos/abc.png');
});
