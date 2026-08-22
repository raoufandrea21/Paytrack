/**
 * Walking somebody's OneDrive to find their documents.
 *
 * The folder tree in the fixtures below is the shape a real one takes: a
 * category folder that says what rather than who, a person's folder inside a
 * group ("Maids"), an "Expired" folder of history, a card split across two
 * files, and a pile of things that are not documents at all.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { isReadable, planImport, scanFolder } from '../src/lib/driveimport.js';

/** A stand-in drive: folders are plain objects, files carry a cTag. */
function fakeDrive(tree) {
  const byId = new Map();
  let next = 1;

  const build = (name, node, parent) => {
    const id = `i${next++}`;
    const isFolder = node !== null && typeof node === 'object';
    const item = isFolder
      ? { id, name, folder: { childCount: Object.keys(node).length } }
      : { id, name, file: {}, size: 1000, cTag: node ?? 'c1' };
    byId.set(id, { item, parent, children: [] });
    if (parent) byId.get(parent).children.push(item);
    if (isFolder) for (const [child, sub] of Object.entries(node)) build(child, sub, id);
    return item;
  };

  const root = build('root', tree, null);
  return {
    root: byId.get(root.id).children.length ? root : root,
    calls: 0,
    listDriveFolder(_clientId, itemId) {
      this.calls += 1;
      return Promise.resolve(byId.get(itemId ?? root.id)?.children ?? []);
    },
    downloadDriveItem() {
      return Promise.resolve(new Blob(['x']));
    },
    find: (name) => [...byId.values()].find((n) => n.item.name === name)?.item,
  };
}

const TREE = {
  "Familly Documents & ID's": {
    'Raouf Andrea': {
      'Passport 2031.jpg': 'c1',
      "Cyprus ID's": { 'Cyprus ID Front.jpg': 'c2', 'Cyprus ID Back.jpg': 'c3' },
      Expired: { 'Old Visa 2019.pdf': 'c4' },
    },
    Maids: { 'Maria Santos': { 'Passport.jpg': 'c5' } },
    'notes.txt': 'c6',
    'holiday.mp4': 'c7',
  },
};

test('only things that could be documents are picked up', () => {
  assert.equal(isReadable('Passport.jpg'), true);
  assert.equal(isReadable('scan.PDF'), true);
  assert.equal(isReadable('photo.heic'), true);
  assert.equal(isReadable('notes.txt'), false);
  assert.equal(isReadable('holiday.mp4'), false);
  assert.equal(isReadable(''), false);
});

test('the walk finds documents at every depth and ignores the rest', async () => {
  const drive = fakeDrive(TREE);
  const root = drive.find("Familly Documents & ID's");
  const { found, skipped } = await scanFolder('c', root, { api: drive });

  assert.deepEqual(found.map((f) => f.path).sort(), [
    "Familly Documents & ID's/Maids/Maria Santos/Passport.jpg",
    "Familly Documents & ID's/Raouf Andrea/Cyprus ID's/Cyprus ID Back.jpg",
    "Familly Documents & ID's/Raouf Andrea/Cyprus ID's/Cyprus ID Front.jpg",
    "Familly Documents & ID's/Raouf Andrea/Expired/Old Visa 2019.pdf",
    "Familly Documents & ID's/Raouf Andrea/Passport 2031.jpg",
  ]);
  assert.equal(skipped.files, 2, 'the text file and the video');
});

test('the path carries the filing the person already did', async () => {
  const drive = fakeDrive(TREE);
  const planned = planImport(
    (await scanFolder('c', drive.find("Familly Documents & ID's"), { api: drive })).found,
  );
  const by = (name) => planned.find((p) => p.name === name);

  assert.equal(by('Passport 2031.jpg').hints.person, 'Raouf Andrea');
  assert.equal(by('Passport 2031.jpg').hints.year, 2031);
  assert.equal(by('Old Visa 2019.pdf').hints.archived, true, 'Expired is history, not a reminder');
  assert.equal(by('Passport.jpg').hints.person, 'Maria Santos');
  assert.equal(by('Passport.jpg').hints.relation, 'Housemaid', 'from the Maids folder above it');
});

test('the two sides of one card become one document', async () => {
  const drive = fakeDrive(TREE);
  const planned = planImport(
    (await scanFolder('c', drive.find("Familly Documents & ID's"), { api: drive })).found,
  );

  const front = planned.find((p) => p.name === 'Cyprus ID Front.jpg');
  assert.ok(front, 'the front is kept');
  assert.equal(front.backItem?.name, 'Cyprus ID Back.jpg', 'and carries the back with it');
  assert.equal(
    planned.filter((p) => p.name === 'Cyprus ID Back.jpg').length,
    0,
    'the back is not a document of its own',
  );
});

test('a folder deeper than the limit is left rather than followed for ever', async () => {
  // A drive can contain anything; the walk must be bounded whatever it meets.
  let deep = { 'buried.jpg': 'c' };
  for (let i = 0; i < 12; i += 1) deep = { [`level${i}`]: deep };
  const drive = fakeDrive({ Documents: deep });

  const { found } = await scanFolder('c', drive.find('Documents'), {
    api: drive,
    limits: { files: 400, depth: 3 },
  });
  assert.equal(found.length, 0, 'nothing found that deep, and no runaway walk');
  assert.ok(drive.calls <= 4, `stopped after ${drive.calls} listings`);
});

test('a folder with more documents than one run says so rather than silently stopping', async () => {
  const many = {};
  for (let i = 0; i < 30; i += 1) many[`doc${i}.jpg`] = `c${i}`;
  const drive = fakeDrive({ Documents: many });

  const result = await scanFolder('c', drive.find('Documents'), {
    api: drive,
    limits: { files: 10, depth: 4 },
  });
  assert.equal(result.found.length, 10);
  assert.equal(result.truncated, true);
});
