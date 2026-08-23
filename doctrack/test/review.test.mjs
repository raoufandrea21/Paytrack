import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewReasonsFor } from '../src/lib/review.js';

test('a missing expiry date is named as the reason', () => {
  assert.match(reviewReasonsFor({ number: 'X1', type: 'passport' }).join(' '), /No expiry date/);
});

test('a document that never expires is not nagged about its date', () => {
  const reasons = reviewReasonsFor({ no_expiry: 1, number: 'X1', type: 'birth_certificate' });
  assert.ok(!reasons.some((r) => /No expiry date/.test(r)), reasons.join(' | '));
});

test('an unrecognised type asks what it is', () => {
  assert.match(
    reviewReasonsFor({ type: 'other', label: '', number: 'X', expiry_date: '2030-01-01' }).join(' '),
    /not recognised/,
  );
});

test('an "other" that was given a name is not complained about', () => {
  const reasons = reviewReasonsFor({
    type: 'other', label: 'Tenancy contract', number: 'X', expiry_date: '2030-01-01',
  });
  assert.deepEqual(reasons, ['Read with low confidence.']);
});

test('the reader\'s own warnings are passed through', () => {
  const reasons = reviewReasonsFor({
    type: 'passport', number: 'X', expiry_date: '2030-01-01',
    extraction: { warnings: ['The date was hard to read.'] },
  });
  assert.ok(reasons.includes('The date was hard to read.'));
});

test('there is always a reason, even when nothing specific is wrong', () => {
  assert.equal(reviewReasonsFor({}).length > 0, true);
  assert.equal(reviewReasonsFor(null).length > 0, true);
});
