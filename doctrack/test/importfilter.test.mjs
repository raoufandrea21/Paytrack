/**
 * Choosing what to pick up out of somebody's drive.
 *
 * The folder holds a decade of everything. Reading all of it turns a tool that
 * saves work into work — sixty rows to verify, most of them for people and
 * papers nobody is tracking. Both questions are answered from the path, before
 * a single byte is downloaded.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_WANTED_TYPES, branchOf, selectForImport } from '../src/lib/driveimport.js';

const ROOT = "Familly Documents & ID's";
const at = (path) => ({ item: { id: path, name: path.split('/').pop() }, path });

const TREE = [
  at(`${ROOT}/Raouf Andrea/Passport 2031.jpg`),
  at(`${ROOT}/Raouf Andrea/Emirates ID Front.jpg`),
  at(`${ROOT}/Raouf Andrea/Emirates ID Back.jpg`),
  at(`${ROOT}/Raouf Andrea/Tenancy Contract 2024.pdf`),
  at(`${ROOT}/Raouf Andrea/IMG_20220714.jpg`),
  at(`${ROOT}/Sandy Charif/Passport.jpg`),
  at(`${ROOT}/Maids/Maria Santos/Residency Visa.pdf`),
  at(`${ROOT}/Uncle George/Passport.jpg`),
  at(`${ROOT}/loose receipt.pdf`),
];

test('the branch is the folder under the one being read, not the file', () => {
  assert.equal(branchOf(`${ROOT}/Raouf Andrea/Passport.jpg`, ROOT), 'Raouf Andrea');
  assert.equal(branchOf(`${ROOT}/Maids/Maria Santos/Passport.jpg`, ROOT), 'Maids');
  assert.equal(branchOf(`${ROOT}/loose.pdf`, ROOT), '', 'a file loose in the root belongs to nobody');
});

test('only the chosen people are read', () => {
  const { taken, left } = selectForImport(TREE, {
    rootName: ROOT,
    branches: ['Raouf Andrea', 'Sandy Charif', 'Maids'],
    types: DEFAULT_WANTED_TYPES,
  });
  assert.equal(taken.some((e) => /Uncle George/.test(e.path)), false, 'Uncle George is not on the list');
  assert.ok(left.person >= 1);
});

test('only the chosen kinds are read, and the rest are counted not lost', () => {
  const { taken, left } = selectForImport(TREE, {
    rootName: ROOT,
    branches: ['Raouf Andrea'],
    types: ['passport'],
  });
  assert.deepEqual(taken.map((e) => e.item.name), ['Passport 2031.jpg']);
  assert.equal(left.kind, 2, 'both sides of the Emirates ID');
  assert.equal(left.unnamed, 2, 'the tenancy contract and the camera filename');
});

test('the back of a card is never judged on its own', () => {
  // "Emirates ID Back.jpg" says its kind, but plenty of backs do not — and a
  // back dropped for saying nothing leaves a one-sided record.
  const sides = [
    at(`${ROOT}/Raouf Andrea/Cyprus ID Front.jpg`),
    at(`${ROOT}/Raouf Andrea/Cyprus ID Back.jpg`),
  ];
  const { taken } = selectForImport(sides, { rootName: ROOT, types: ['cyprus_id'] });
  assert.equal(taken.length, 2, 'both sides survive the filter');
});

test('a file whose name says nothing is left alone unless asked for', () => {
  const camera = [at(`${ROOT}/Raouf Andrea/IMG_20220714.jpg`)];
  assert.equal(selectForImport(camera, { rootName: ROOT }).taken.length, 0);
  assert.equal(selectForImport(camera, { rootName: ROOT, unnamed: true }).taken.length, 1);
});

test('with nothing chosen it takes everything it can name', () => {
  const { taken } = selectForImport(TREE, { rootName: ROOT });
  assert.ok(taken.length > 0);
  assert.equal(taken.some((e) => /IMG_2022/.test(e.path)), false, 'still not the camera roll');
});

test('the default list covers what a household actually tracks', () => {
  for (const kind of ['emirates_id', 'passport', 'residency_visa', 'cyprus_id',
    'driving_license', 'vehicle_registration', 'car_insurance', 'health_insurance',
    'vaccination', 'birth_certificate', 'marriage_certificate']) {
    assert.ok(DEFAULT_WANTED_TYPES.includes(kind), `${kind} should be tracked by default`);
  }
});
