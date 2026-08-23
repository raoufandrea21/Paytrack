/**
 * pdf.js will not render a page without these, and rendering is how a scanned
 * PDF becomes something OCR can read — so a mistake here is a whole class of
 * document that silently cannot be filed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { installPdfShims } from '../src/lib/pdfshims.js';

installPdfShims();

test('getOrInsertComputed inserts once and then returns what is there', () => {
  const map = new Map();
  let calls = 0;
  const make = () => { calls += 1; return { made: calls }; };

  const first = map.getOrInsertComputed('a', make);
  const second = map.getOrInsertComputed('a', make);
  assert.equal(calls, 1, 'the second call must not recompute');
  assert.equal(first, second);
  assert.equal(map.size, 1);
});

test('getOrInsertComputed is given the key', () => {
  const map = new Map();
  assert.equal(map.getOrInsertComputed('x', (key) => key.toUpperCase()), 'X');
});

test('a stored undefined still counts as present', () => {
  const map = new Map([['a', undefined]]);
  let called = false;
  map.getOrInsertComputed('a', () => { called = true; return 1; });
  assert.equal(called, false, 'has(), not a truthiness check');
});

test('getOrInsert takes a value rather than a function', () => {
  const map = new Map();
  assert.equal(map.getOrInsert('a', 1), 1);
  assert.equal(map.getOrInsert('a', 2), 1);
});

// ------------------------------------------------------------- sumPrecise

test('it adds up', () => {
  assert.equal(Math.sumPrecise([1, 2, 3]), 6);
  assert.equal(Math.sumPrecise([2.5, -1.5]), 1);
});

test('it beats a naive loop on the case it exists for', () => {
  const items = [1e20, 0.1, -1e20];
  assert.equal(items.reduce((a, b) => a + b, 0), 0, 'the naive sum loses the 0.1');
  assert.equal(Math.sumPrecise(items), 0.1);
});

test('an empty list is negative zero', () => {
  assert.ok(Object.is(Math.sumPrecise([]), -0));
});

test('infinities', () => {
  assert.equal(Math.sumPrecise([1, Infinity]), Infinity);
  assert.equal(Math.sumPrecise([1, -Infinity]), -Infinity);
  assert.ok(Number.isNaN(Math.sumPrecise([Infinity, -Infinity])));
  assert.ok(Number.isNaN(Math.sumPrecise([1, NaN])));
});

test('anything that is not a number is refused', () => {
  assert.throws(() => Math.sumPrecise([1, '2']), TypeError);
  assert.throws(() => Math.sumPrecise([1, null]), TypeError);
});

test('it takes any iterable, not just an array', () => {
  assert.equal(Math.sumPrecise(new Set([1, 2, 3])), 6);
  assert.equal(Math.sumPrecise((function* g() { yield 1; yield 2; })()), 3);
});

test('installing twice leaves a real implementation alone', () => {
  const marker = () => 'native';
  Object.defineProperty(Map.prototype, 'getOrInsertComputed', {
    value: marker, writable: true, configurable: true,
  });
  installPdfShims();
  assert.equal(Map.prototype.getOrInsertComputed, marker, 'it must not overwrite what exists');
  delete Map.prototype.getOrInsertComputed;
  installPdfShims();
  assert.equal(typeof Map.prototype.getOrInsertComputed, 'function');
});

test('many infinities in both directions is still no answer', () => {
  assert.ok(Number.isNaN(Math.sumPrecise([Infinity, Infinity, -Infinity])));
  assert.ok(Number.isNaN(Math.sumPrecise([-Infinity, Infinity, Infinity, 5])));
  assert.equal(Math.sumPrecise([Infinity, Infinity, 5]), Infinity);
});
