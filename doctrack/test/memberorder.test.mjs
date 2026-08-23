import test from 'node:test';
import assert from 'node:assert/strict';
import { applyOrder, cleanOrder, hasOrder, moveItem } from '../src/lib/memberorder.js';

const people = [
  { uid: 'a', name: 'Raouf', created_at: '2026-01-01' },
  { uid: 'b', name: 'Sandy', created_at: '2026-01-02' },
  { uid: 'c', name: 'Lily', created_at: '2026-01-03' },
];
const names = (list) => list.map((m) => m.name).join(',');

test('no saved order leaves the list as it was', () => {
  assert.equal(names(applyOrder(people, null)), 'Raouf,Sandy,Lily');
  assert.equal(names(applyOrder(people, [])), 'Raouf,Sandy,Lily');
  assert.ok(!hasOrder(null, people));
});

test('a saved order is honoured', () => {
  assert.equal(names(applyOrder(people, ['c', 'a', 'b'])), 'Lily,Raouf,Sandy');
  assert.ok(hasOrder(['c', 'a', 'b'], people));
});

test('somebody added since goes to the end, not somewhere arbitrary', () => {
  const withNew = [...people, { uid: 'd', name: 'Andreas', created_at: '2026-02-01' }];
  assert.equal(names(applyOrder(withNew, ['c', 'a', 'b'])), 'Lily,Raouf,Sandy,Andreas');
});

test('two new people keep the order they were added in', () => {
  const withNew = [
    ...people,
    { uid: 'e', name: 'Second', created_at: '2026-03-01' },
    { uid: 'd', name: 'First', created_at: '2026-02-01' },
  ];
  assert.equal(names(applyOrder(withNew, ['a'])).split(',').slice(-2).join(','), 'First,Second');
});

test('a uid for somebody deleted is ignored rather than breaking the sort', () => {
  assert.equal(names(applyOrder(people, ['gone', 'c', 'also-gone', 'a'])), 'Lily,Raouf,Sandy');
  assert.deepEqual(cleanOrder(['gone', 'c', 'c', 'a'], people), ['c', 'a']);
});

test('rubbish in the setting is not an order', () => {
  for (const bad of [null, undefined, 'c,a,b', 42, {}]) {
    assert.equal(names(applyOrder(people, bad)), 'Raouf,Sandy,Lily', JSON.stringify(bad));
    assert.ok(!hasOrder(bad, people));
  }
});

test('an order naming nobody who exists is not an order', () => {
  assert.ok(!hasOrder(['x', 'y'], people));
});

// ------------------------------------------------------------------ moving

test('moving down shifts the others up', () => {
  assert.deepEqual(moveItem(['a', 'b', 'c'], 0, 2), ['b', 'c', 'a']);
});

test('moving up shifts the others down', () => {
  assert.deepEqual(moveItem(['a', 'b', 'c'], 2, 0), ['c', 'a', 'b']);
});

test('moving past either end stops at the end', () => {
  assert.deepEqual(moveItem(['a', 'b', 'c'], 1, -5), ['b', 'a', 'c']);
  assert.deepEqual(moveItem(['a', 'b', 'c'], 1, 99), ['a', 'c', 'b']);
});

test('moving something that is not there changes nothing', () => {
  assert.deepEqual(moveItem(['a', 'b'], 7, 0), ['a', 'b']);
});

test('moving somewhere it already is changes nothing', () => {
  assert.deepEqual(moveItem(['a', 'b', 'c'], 1, 1), ['a', 'b', 'c']);
});
