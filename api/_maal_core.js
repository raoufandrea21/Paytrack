// Pure logic for the Maal link. No network, no database: everything here is
// tested in tests/maal.test.mjs, and api/maal.js only moves data in and out.
//
// Maal is the phone app that reads bank messages. It sees money leave the bank;
// PayTrack knows what that money was for. The link lets Maal (1) read what is
// owed, (2) propose "this bank payment is that scheduled payment", and (3) turn
// a card purchase converted into instalments into a PayTrack account.

// ── dates ────────────────────────────────────────────────────────────────
// PayTrack stores DD-MM-YYYY. The link speaks YYYY-MM-DD.
export function toIso(ddmmyyyy) {
  const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(String(ddmmyyyy || ''));
  return m ? `${m[3]}-${m[2]}-${m[1]}` : '';
}
export function fromIso(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  return m ? `${m[3]}-${m[2]}-${m[1]}` : '';
}
function addMonthsIso(iso, n) {
  const [y, mo, d] = iso.split('-').map(Number);
  const target = new Date(Date.UTC(y, mo - 1 + n, 1));
  const dim = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, dim));
  return target.toISOString().slice(0, 10);
}

// The date that counts: a revised date when one is set, else the original.
export const effDate = (p) => (p && p.nd) || (p && p.dt) || '';
const OWED = (p) => p && p.status !== 'paid' && p.status !== 'deferred';

// ── payment keys ─────────────────────────────────────────────────────────
// Payments have no id in PayTrack: the web app addresses them by position,
// which moves when a row is added or removed. A key built from what the
// payment IS (account, original date, amount, cheque) survives reordering, and
// a payment edited in the meantime simply stops matching -- which is the safe
// failure: the proposal goes stale instead of marking the wrong row paid.
export function paymentKey(accId, p, occurrence = 0) {
  return [accId, p.dt || '', Math.round(Number(p.amount || 0) * 100), p.chq || '', occurrence].join('|');
}

export function keyedPayments(acc) {
  const seen = new Map();
  return (acc.pays || []).map((p, index) => {
    const base = paymentKey(acc.id, p, 0).replace(/\|0$/, '');
    const n = seen.get(base) || 0;
    seen.set(base, n + 1);
    return { key: paymentKey(acc.id, p, n), index, p };
  });
}

export function findPayment(data, key) {
  for (const acc of data.accs || []) {
    if (!String(key).startsWith(acc.id + '|')) continue;
    const hit = keyedPayments(acc).find((k) => k.key === key);
    if (hit) return { acc, index: hit.index, p: hit.p };
  }
  return null;
}

// ── what Maal reads ──────────────────────────────────────────────────────
export function scheduleView(data, todayIso, opts = {}) {
  const paidWindowDays = opts.paidWindowDays ?? 60;
  const since = new Date(new Date(todayIso + 'T00:00:00Z').getTime() - paidWindowDays * 86400000).toISOString().slice(0, 10);
  const accounts = [];
  const payments = [];
  for (const acc of data.accs || []) {
    // Per-account totals over EVERY payment, not just the ones listed below, so Maal can show
    // "23 of 53 paid" and what is left without being sent the whole history.
    const pays = acc.pays || [];
    const scheduled = pays.filter((p) => p.status !== 'deferred');
    const owedPays = scheduled.filter(OWED);
    const nextOwed = owedPays.map((p) => toIso(effDate(p))).filter(Boolean).sort()[0] || null;
    const scheduledTotal = scheduled.reduce((n, p) => n + Number(p.amount || 0), 0);
    accounts.push({
      id: acc.id, name: acc.name, type: acc.type || 'Other', purpose: acc.purpose || null, maalId: acc.maalId || null,
      totalCount: scheduled.length,
      paidCount: scheduled.length - owedPays.length,
      remaining: Math.round((owedPays.reduce((n, p) => n + Number(p.amount || 0), 0) + Math.max(0, Number(acc.principal || 0) - scheduledTotal)) * 100) / 100,
      nextDue: nextOwed,
      nextAmount: nextOwed ? Number((owedPays.find((p) => toIso(effDate(p)) === nextOwed) || {}).amount || 0) : null,
    });
    for (const { key, p } of keyedPayments(acc)) {
      const date = toIso(effDate(p));
      const owed = OWED(p);
      // Owed payments are what Maal matches against; recently paid ones stop it
      // proposing the same bank row twice.
      if (!owed && !(p.status === 'paid' && date >= since)) continue;
      payments.push({
        key,
        accId: acc.id,
        accName: acc.name,
        accType: acc.type || 'Other',
        purpose: acc.purpose || null,
        desc: p.desc || '',
        amount: Number(p.amount || 0),
        date,
        chq: p.chq || '',
        status: p.status || 'notpaid',
      });
    }
  }
  payments.sort((a, b) => (a.date || '9999').localeCompare(b.date || '9999'));
  return { accounts, payments };
}

// ── proposals ────────────────────────────────────────────────────────────
// What a proposal must say to be believed: the bank amount has to equal the
// scheduled amount to the fils, and the payment must still be owed.
export function checkProposal(data, prop) {
  const hit = findPayment(data, prop.key);
  if (!hit) return { ok: false, reason: 'payment-not-found' };
  if (!OWED(hit.p)) return { ok: false, reason: 'already-' + hit.p.status };
  const want = Math.round(Number(hit.p.amount) * 100);
  const got = Math.round(Number(prop.amount) * 100);
  if (want !== got) return { ok: false, reason: 'amount-mismatch' };
  return { ok: true, hit };
}

export function markPaid(data, key) {
  const hit = findPayment(data, key);
  if (!hit) throw new Error('payment-not-found');
  if (!OWED(hit.p)) throw new Error('already-' + hit.p.status);
  hit.acc.pays[hit.index].status = 'paid';
  return hit;
}

export function addToInbox(inbox, prop, nowIso) {
  const list = Array.isArray(inbox) ? inbox.slice() : [];
  // One proposal per bank row and one per payment: a repeat sync is not news.
  if (list.some((x) => x.txId === prop.txId || x.key === prop.key)) return { list, added: false };
  list.push({
    id: 'mx' + Date.parse(nowIso).toString(36) + Math.random().toString(36).slice(2, 6),
    key: prop.key,
    txId: String(prop.txId),
    amount: Number(prop.amount),
    bankDate: String(prop.date || '').slice(0, 10),
    merchant: String(prop.merchant || '').slice(0, 80),
    bank: String(prop.bank || '').slice(0, 40),
    accName: String(prop.accName || '').slice(0, 80),
    desc: String(prop.desc || '').slice(0, 120),
    dueDate: String(prop.dueDate || '').slice(0, 10),
    at: nowIso,
  });
  // Bounded: a runaway client can never grow this record without limit.
  while (list.length > 50) list.shift();
  return { list, added: true };
}

// ── plans from Maal ──────────────────────────────────────────────────────
// A card purchase converted into instalments, made in Maal because that is
// quicker, becomes a PayTrack account with its payments laid out. Idempotent by
// maalId: sending the same plan twice returns the account already made.
export function buildPlanAccount(input) {
  const months = Math.max(1, Math.min(600, Math.round(Number(input.months))));
  const monthly = Math.round(Number(input.monthlyAmount) * 100) / 100;
  const first = String(input.firstPayment || '').slice(0, 10);
  const step = Math.max(1, Math.round(Number(input.intervalMonths || 1)));
  if (!input.maalId || !input.name || !(monthly > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(first)) throw new Error('invalid-plan');
  const total = input.totalAmount ? Math.round(Number(input.totalAmount) * 100) / 100 : Math.round(monthly * months * 100) / 100;
  const pays = Array.from({ length: months }, (_, k) => ({
    desc: `Instalment ${k + 1} of ${months}`,
    amount: monthly,
    dt: fromIso(k === 0 ? first : addMonthsIso(first, k * step)),
    nd: '',
    chq: '',
    pct: '',
    status: 'notpaid',
  }));
  return {
    id: 'maal-' + String(input.maalId).replace(/[^a-zA-Z0-9-]/g, '').slice(0, 40),
    name: String(input.name).slice(0, 80),
    type: input.type || 'Installments',
    principal: total,
    url: '',
    remDays: 3,
    defer: false,
    purpose: input.purpose === 'buy' ? 'buy' : 'expense',
    source: 'maal',
    maalId: String(input.maalId),
    note: String(input.note || '').slice(0, 200),
    pays,
  };
}

export function upsertPlan(data, input) {
  const existing = (data.accs || []).find((a) => a.maalId && a.maalId === String(input.maalId));
  if (existing) return { acc: existing, created: false };
  const acc = buildPlanAccount(input);
  if ((data.accs || []).some((a) => a.id === acc.id)) throw new Error('id-taken');
  data.accs = [...(data.accs || []), acc];
  return { acc, created: true };
}
