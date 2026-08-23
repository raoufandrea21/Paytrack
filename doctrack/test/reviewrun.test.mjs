/**
 * The counter and the order of a pass through the "needs checking" pile. The
 * bug this guards against is the one that makes a pile of thirty-eight feel
 * endless: a number that moves, and an order that doubles back.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { positionIn } from '../src/lib/reviewrun.js';

const run = [10, 20, 30, 40];

test('your place in the run does not move as you clear it', () => {
  assert.deepEqual(positionIn(run, 10, [10, 20, 30, 40]), {
    index: 1, total: 4, remaining: 4, nextId: 20,
  });
  // Ten is done; the run is still four long and you are on the second of them.
  assert.deepEqual(positionIn(run, 20, [20, 30, 40]), {
    index: 2, total: 4, remaining: 3, nextId: 30,
  });
});

test('a document dealt with earlier is stepped over, not shown again', () => {
  // 30 was fixed on the other device mid-run.
  assert.equal(positionIn(run, 20, [20, 40]).nextId, 40);
});

test('one you skipped still counts as something to do', () => {
  // 10 was skipped and is behind you, but it has not gone away.
  assert.equal(positionIn(run, 20, [10, 20, 30, 40]).remaining, 4);
  assert.equal(positionIn(run, 30, [10, 30, 40]).remaining, 3);
});

test('but skipping does not send you backwards', () => {
  assert.equal(positionIn(run, 30, [10, 30, 40]).nextId, 40, 'forwards only');
});

test('the last one has nowhere to go', () => {
  assert.equal(positionIn(run, 40, [40]).nextId, null);
  assert.equal(positionIn(run, 40, [10, 40]).nextId, null, 'even with one skipped behind');
});

test('a document that is not part of the run has no position', () => {
  assert.equal(positionIn(run, 99, [99]), null);
  assert.equal(positionIn([], 10, [10]), null);
  assert.equal(positionIn(null, 10, [10]), null);
});

test('the id can arrive as a string, because it comes from a URL', () => {
  assert.equal(positionIn(run, '20', [20, 30]).index, 2);
});

test('a Set and an array of pending ids mean the same thing', () => {
  assert.deepEqual(positionIn(run, 10, new Set([10, 20])), positionIn(run, 10, [10, 20]));
});

test('nothing pending leaves a finished run', () => {
  const spot = positionIn(run, 40, []);
  assert.equal(spot.remaining, 0);
  assert.equal(spot.nextId, null);
});
