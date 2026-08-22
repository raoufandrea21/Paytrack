import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FALLBACK_LEADS,
  OVERDUE_CHOICES,
  defaultRules,
  describeDays,
  describeLeads,
  describeRules,
  isDefaultRules,
  isMuted,
  leadsFor,
  normaliseRules,
  rungsFor,
} from '../src/lib/reminderrules.js';

// ------------------------------------------------------------ the defaults

test('a passport warns half a year ahead, insurance only weeks', () => {
  const rules = defaultRules();
  assert.equal(Math.max(...leadsFor('passport', rules)), 180);
  assert.equal(Math.max(...leadsFor('car_insurance', rules)), 30);
});

test('documents that never expire are never reminded about', () => {
  const rules = defaultRules();
  for (const type of ['birth_certificate', 'marriage_certificate', 'education_certificate']) {
    assert.ok(isMuted(type, rules), type);
    assert.deepEqual(leadsFor(type, rules), []);
  }
});

test('a type nobody wrote a rule for still gets the fallback', () => {
  assert.deepEqual(leadsFor('made_up_type', { types: {}, muted: [] }), []);
  const rules = normaliseRules({ types: { other: [] } });
  assert.deepEqual(leadsFor('other', rules), FALLBACK_LEADS);
});

// --------------------------------------------------------------- tolerance

test('rubbish in settings falls back rather than silencing everything', () => {
  for (const bad of [null, undefined, 'nonsense', 42, [], { types: 'no' }]) {
    const rules = normaliseRules(bad);
    assert.ok(leadsFor('passport', rules).length > 0, JSON.stringify(bad));
  }
});

test('nonsense lead times are dropped, the rest kept', () => {
  const rules = normaliseRules({ types: { passport: [30, -5, 0, 'x', 9999, 7, 7] } });
  assert.deepEqual(rules.types.passport, [30, 7]);
});

test('muting an unknown type is ignored', () => {
  const rules = normaliseRules({ muted: ['passport', 'not_a_type'] });
  assert.deepEqual(rules.muted, ['passport']);
  assert.ok(isMuted('passport', rules));
  assert.ok(!isMuted('emirates_id', rules));
});

test('an overdue repeat that is not on the menu falls back to the default', () => {
  assert.equal(normaliseRules({ overdueRepeat: 11 }).overdueRepeat, defaultRules().overdueRepeat);
  for (const days of OVERDUE_CHOICES) {
    assert.equal(normaliseRules({ overdueRepeat: days }).overdueRepeat, days);
  }
});

test('zero is a real answer — say it once and stop', () => {
  assert.equal(normaliseRules({ overdueRepeat: 0 }).overdueRepeat, 0);
});

// ------------------------------------------------------------------- rungs

test('rungs are offered most urgent first', () => {
  const rules = normaliseRules({ types: { passport: [180, 30, 7] } });
  assert.deepEqual(rungsFor('passport', 200, rules), [7, 30, 180]);
});

test('an overdue document gets a repeat rung ahead of the rest', () => {
  const rules = normaliseRules({ types: { passport: [30, 7] }, overdueRepeat: 7 });
  assert.deepEqual(rungsFor('passport', -9, rules), [-7, 7, 30]);
  assert.deepEqual(rungsFor('passport', -16, rules), [-14, 7, 30]);
});

test('the repeat rung only appears once a whole period has passed', () => {
  const rules = normaliseRules({ types: { passport: [30] }, overdueRepeat: 7 });
  assert.deepEqual(rungsFor('passport', -3, rules), [30]);
  assert.deepEqual(rungsFor('passport', -7, rules), [-7, 30]);
});

test('turning the repeat off leaves an overdue document with the ordinary rungs', () => {
  const rules = normaliseRules({ types: { passport: [30] }, overdueRepeat: 0 });
  assert.deepEqual(rungsFor('passport', -40, rules), [30]);
});

test('a silenced type has no rungs at all, overdue or not', () => {
  const rules = normaliseRules({ muted: ['passport'], overdueRepeat: 7 });
  assert.deepEqual(rungsFor('passport', 5, rules), []);
  assert.deepEqual(rungsFor('passport', -50, rules), []);
});

// --------------------------------------------------------------- the words

test('lead times are read out in the unit a person would use', () => {
  assert.equal(describeDays(1), '1 day');
  assert.equal(describeDays(3), '3 days');
  assert.equal(describeDays(7), '1 week');
  assert.equal(describeDays(14), '2 weeks');
  assert.equal(describeDays(30), '1 month');
  assert.equal(describeDays(90), '3 months');
  assert.equal(describeDays(180), '6 months');
  assert.equal(describeDays(365), '1 year');
});

test('a ladder reads as a sentence', () => {
  assert.equal(describeLeads([7, 180, 30]), '6 months, 1 month and 1 week before');
  assert.equal(describeLeads([7]), '1 week before');
  assert.equal(describeLeads([]), 'Never');
});

test('the settings summary counts what is on and what is off', () => {
  const line = describeRules(defaultRules());
  assert.match(line, /kinds of document/);
  assert.match(line, /repeats every 1 week once overdue/);
  assert.match(describeRules({ ...defaultRules(), muted: ['passport'] }), /1 silenced/);
  assert.match(describeRules({ ...defaultRules(), overdueRepeat: 0 }), /no repeat once overdue/);
});

test('the reset button knows whether anything was changed', () => {
  assert.ok(isDefaultRules(defaultRules()));
  assert.ok(isDefaultRules(null));
  assert.ok(!isDefaultRules({ ...defaultRules(), muted: ['passport'] }));
  assert.ok(!isDefaultRules({ ...defaultRules(), overdueRepeat: 30 }));
  const changed = defaultRules();
  changed.types.passport = [7];
  assert.ok(!isDefaultRules(changed));
});
