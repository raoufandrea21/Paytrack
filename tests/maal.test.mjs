import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toIso, fromIso, keyedPayments, findPayment, scheduleView, checkProposal, markPaid, addToInbox, buildPlanAccount, upsertPlan } from '../api/_maal_core.js';

const sample = () => ({
  accs: [
    {
      id: 'villa', name: 'Villa plan', type: 'Installments', purpose: 'buy', principal: 1000000,
      pays: [
        { desc: 'Cheque 4', amount: 292950, dt: '31-08-2026', nd: '', chq: '004', status: 'overdue' },
        { desc: 'Cheque 5', amount: 292950, dt: '31-08-2026', nd: '', chq: '005', status: 'overdue' },
        { desc: 'Cheque 6', amount: 193956.55, dt: '31-08-2026', nd: '', chq: '006', status: 'confirm' },
        { desc: 'Cheque 7', amount: 292950, dt: '05-10-2026', nd: '', chq: '007', status: 'notpaid' },
        { desc: 'Old', amount: 1000, dt: '01-01-2026', nd: '', chq: '', status: 'paid' },
      ],
    },
    { id: 'loan', name: 'Personal loan', type: 'Cash Loan', principal: 0, pays: [
      { desc: 'Sep', amount: 22852.06, dt: '10-09-2026', nd: '12-09-2026', chq: '', status: 'paid' },
      { desc: 'Oct', amount: 22852.06, dt: '10-10-2026', nd: '', chq: '', status: 'notpaid' },
      { desc: 'Oct dup', amount: 22852.06, dt: '10-10-2026', nd: '', chq: '', status: 'notpaid' },
    ] },
  ],
  stocks: [{ ticker: 'X' }], savings: [], margins: {}, saved: '2026-09-16T00:00:00.000Z',
});

test('dates convert both ways', () => {
  assert.equal(toIso('31-08-2026'), '2026-08-31');
  assert.equal(fromIso('2026-08-31'), '31-08-2026');
  assert.equal(toIso('bad'), '');
});

test('keys stay unique for identical payments and survive reordering', () => {
  const d = sample();
  const keys = keyedPayments(d.accs[1]).map((k) => k.key);
  assert.equal(new Set(keys).size, keys.length);
  const target = keyedPayments(d.accs[0])[2].key;
  d.accs[0].pays.reverse();
  const hit = findPayment(d, target);
  assert.equal(hit.p.desc, 'Cheque 6');
});

test('the schedule lists what is owed plus recent payments, in date order', () => {
  const v = scheduleView(sample(), '2026-09-16');
  assert.deepEqual(v.payments.map((p) => p.desc), ['Cheque 4', 'Cheque 5', 'Cheque 6', 'Sep', 'Cheque 7', 'Oct', 'Oct dup']);
  assert.equal(v.payments.find((p) => p.desc === 'Sep').date, '2026-09-12');
  assert.ok(!v.payments.some((p) => p.desc === 'Old'));
});

test('a proposal must match the amount to the fils and point at an owed payment', () => {
  const d = sample();
  const key = scheduleView(d, '2026-09-16').payments.find((p) => p.desc === 'Cheque 6').key;
  assert.equal(checkProposal(d, { key, amount: 193956.55 }).ok, true);
  assert.equal(checkProposal(d, { key, amount: 193956.5 }).reason, 'amount-mismatch');
  assert.equal(checkProposal(d, { key: 'villa|nope', amount: 1 }).reason, 'payment-not-found');
  const paidKey = scheduleView(d, '2026-09-16').payments.find((p) => p.desc === 'Sep').key;
  assert.equal(checkProposal(d, { key: paidKey, amount: 22852.06 }).reason, 'already-paid');
});

test('marking paid changes exactly one payment and nothing else', () => {
  const d = sample();
  const before = JSON.stringify(d);
  const key = scheduleView(d, '2026-09-16').payments.find((p) => p.desc === 'Cheque 5').key;
  markPaid(d, key);
  const after = JSON.parse(JSON.stringify(d));
  const orig = JSON.parse(before);
  orig.accs[0].pays[1].status = 'paid';
  assert.deepEqual(after, orig);
  assert.throws(() => markPaid(d, key), /already-paid/);
});

test('the inbox ignores repeats and stays bounded', () => {
  let list = [];
  const p = { key: 'k1', txId: 't1', amount: 1 };
  list = addToInbox(list, p, '2026-09-16T10:00:00.000Z').list;
  assert.equal(addToInbox(list, p, '2026-09-16T10:01:00.000Z').added, false);
  assert.equal(addToInbox(list, { ...p, txId: 't2' }, '2026-09-16T10:01:00.000Z').added, false);
  for (let i = 0; i < 80; i++) list = addToInbox(list, { key: 'k' + i + 'x', txId: 'tx' + i, amount: 1 }, '2026-09-16T10:00:00.000Z').list;
  assert.equal(list.length, 50);
});

test('a Maal plan becomes an account with its payments laid out, once', () => {
  const d = sample();
  const input = { maalId: 'plan-car', name: 'Car nissan for new driver', monthlyAmount: 20000, months: 3, firstPayment: '2026-09-28', totalAmount: 60000, purpose: 'expense' };
  const acc = buildPlanAccount(input);
  assert.deepEqual(acc.pays.map((p) => p.dt), ['28-09-2026', '28-10-2026', '28-11-2026']);
  assert.equal(acc.principal, 60000);
  assert.equal(upsertPlan(d, input).created, true);
  assert.equal(upsertPlan(d, input).created, false);
  assert.equal(d.accs.filter((a) => a.maalId === 'plan-car').length, 1);
  assert.equal(d.stocks.length, 1);
  assert.throws(() => buildPlanAccount({ ...input, firstPayment: '28-09-2026' }), /invalid-plan/);
});

test('month ends clamp instead of spilling into the next month', () => {
  const acc = buildPlanAccount({ maalId: 'm', name: 'x', monthlyAmount: 10, months: 3, firstPayment: '2026-01-31' });
  assert.deepEqual(acc.pays.map((p) => p.dt), ['31-01-2026', '28-02-2026', '31-03-2026']);
});
