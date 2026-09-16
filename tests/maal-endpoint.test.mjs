// Runs the real api/maal.js and api/load.js against an in-memory stand-in for
// Upstash, so the whole path -- auth, reads, version-checked writes -- is
// exercised without touching the live database.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.KV_REST_API_URL = 'https://fake-kv.local';
process.env.KV_REST_API_TOKEN = 'test';

const store = new Map();
let requests = 0;
let beforeCas = null;   // lets a test make another device save in the gap
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

function run(cmd) {
  const [op, ...a] = cmd;
  const g = (k) => (store.has(k) ? store.get(k) : null);
  switch (op) {
    case 'GET': return g(a[0]);
    case 'SET': store.set(a[0], String(a[1])); return 'OK';
    case 'MGET': return a.map(g);
    case 'EXISTS': return store.has(a[0]) ? 1 : 0;
    case 'DEL': return store.delete(a[0]) ? 1 : 0;
    case 'SETNX': if (store.has(a[0])) return 0; store.set(a[0], String(a[1])); return 1;
    case 'INCR': { const v = Number(g(a[0]) || 0) + 1; store.set(a[0], String(v)); return v; }
    case 'EXPIRE': return 1;
    case 'EVAL': {
      const [script, n, ...rest] = a;
      const keys = rest.slice(0, Number(n));
      const argv = rest.slice(Number(n));
      if (script.includes("k ~= ARGV[1]")) {
        run(['INCR', keys[1]]);
        const k = g(keys[0]);
        if (!k || k !== argv[0]) return [0];
        return [1, g(keys[2]) || '', g(keys[3]) || '', g(keys[4]) || '', g(keys[5]) || ''];
      }
      if (script.includes("redis.call('SET', KEYS[2], ARGV[3])")) {
        if (beforeCas) { beforeCas(); beforeCas = null; }
        const v = g(keys[0]);
        if ((v === null && argv[0] === '') || v === argv[0]) { store.set(keys[0], argv[1]); store.set(keys[1], argv[2]); return 1; }
        return 0;
      }
      if (script.includes("'pt_webauthn'") || script.includes('EXISTS')) {
        // The web app's session gate: passcode configured, session valid.
        run(['INCR', keys[2]]);
        return [store.has(keys[0]) ? 1 : 0, store.has(keys[1]) ? 1 : 0, 1, 0];
      }
      throw new Error('unknown script');
    }
    default: throw new Error('unsupported ' + op);
  }
}

globalThis.fetch = async (url, init = {}) => {
  requests++;
  const u = String(url);
  let result;
  if (u === process.env.KV_REST_API_URL) result = run(JSON.parse(init.body));
  else if (u.includes('/get/')) result = run(['GET', decodeURIComponent(u.split('/get/')[1])]);
  else throw new Error('unexpected fetch ' + u);
  return { ok: true, status: 200, json: async () => ({ result }), text: async () => '' };
};

const { default: maal } = await import('../api/maal.js');
const { default: load } = await import('../api/load.js');

function call(handler, { method = 'GET', query = {}, body, headers = {} }) {
  return new Promise((resolve) => {
    const res = {
      code: 200,
      headers: {},
      setHeader(k, v) { this.headers[k] = v; },
      status(c) { this.code = c; return this; },
      json(j) { resolve({ status: this.code, body: j }); return this; },
      end() { resolve({ status: this.code, body: null }); return this; },
    };
    handler({ method, query, body, headers }, res);
  });
}

const DATA = {
  accs: [
    { id: 'villa', name: 'Villa plan', type: 'Installments', purpose: 'buy', principal: 900000, pays: [
      { desc: 'Cheque 4', amount: 292950, dt: '31-08-2026', nd: '', chq: '004', status: 'overdue' },
      { desc: 'Cheque 7', amount: 292950, dt: '05-10-2026', nd: '', chq: '007', status: 'notpaid' },
    ] },
  ],
  stocks: [{ ticker: 'EMAAR', qty: 10 }], savings: [{ bank: 'NBF', amount: 5 }], margins: { X: 1 },
  saved: '2026-09-16T10:00:00.000Z',
};
const KEY = 'a'.repeat(64);
const owner = { cookie: 'pt_session=' + 'b'.repeat(64) };
const bearer = { authorization: 'Bearer ' + KEY };

beforeEach(() => {
  store.clear();
  store.set('paytrack_data', JSON.stringify({ value: JSON.stringify(DATA) }));
  store.set('pt_data_ver', String(Date.parse(DATA.saved)));
  store.set('pt_auth', 'hash');
  store.set('pt_sess_' + 'b'.repeat(64), '1');
  store.set('pt_maal_key', sha(KEY));
  requests = 0;
});
const stored = () => JSON.parse(JSON.parse(store.get('paytrack_data')).value);

test('a wrong or missing key reads nothing', async () => {
  assert.equal((await call(maal, { query: { action: 'schedule' } })).status, 401);
  assert.equal((await call(maal, { query: { action: 'schedule' }, headers: { authorization: 'Bearer ' + 'c'.repeat(64) } })).status, 401);
});

test('reading the schedule costs one database request', async () => {
  const r = await call(maal, { query: { action: 'schedule' }, headers: bearer });
  assert.equal(r.status, 200);
  assert.equal(requests, 1);
  assert.equal(r.body.payments.length, 2);
  assert.equal(r.body.autoMark, false);
});

test('with automatic marking off, a proposal changes nothing and waits in the inbox', async () => {
  const before = store.get('paytrack_data');
  const { body } = await call(maal, { query: { action: 'schedule' }, headers: bearer });
  const key = body.payments[0].key;
  const r = await call(maal, { method: 'POST', query: { action: 'propose' }, headers: bearer, body: { key, txId: 't1', amount: 292950, date: '2026-08-31', merchant: 'Inward Cheques', bank: 'NBF Current' } });
  assert.equal(r.body.status, 'pending');
  assert.equal(store.get('paytrack_data'), before);
  const loaded = await call(load, { headers: owner });
  assert.equal(loaded.body.maalInbox.length, 1);
  assert.equal(loaded.body.maalInbox[0].desc, 'Cheque 4');
});

test('accepting in PayTrack marks exactly that payment paid and keeps everything else', async () => {
  const { body } = await call(maal, { query: { action: 'schedule' }, headers: bearer });
  await call(maal, { method: 'POST', query: { action: 'propose' }, headers: bearer, body: { key: body.payments[0].key, txId: 't1', amount: 292950 } });
  const id = JSON.parse(store.get('pt_maal_inbox')).items[0].id;
  const r = await call(maal, { method: 'POST', query: { action: 'resolve' }, headers: owner, body: { id, accept: true } });
  assert.equal(r.body.status, 'marked');
  const after = stored();
  assert.deepEqual(after.accs[0].pays.map((p) => p.status), ['paid', 'notpaid']);
  assert.deepEqual(after.stocks, DATA.stocks);
  assert.deepEqual(after.savings, DATA.savings);
  assert.deepEqual(after.margins, DATA.margins);
  assert.equal(JSON.parse(store.get('pt_maal_inbox')).items.length, 0);
  assert.notEqual(store.get('pt_data_ver'), String(Date.parse(DATA.saved)));
});

test('rejecting stops the same bank row being proposed again', async () => {
  const { body } = await call(maal, { query: { action: 'schedule' }, headers: bearer });
  await call(maal, { method: 'POST', query: { action: 'propose' }, headers: bearer, body: { key: body.payments[0].key, txId: 't1', amount: 292950 } });
  const id = JSON.parse(store.get('pt_maal_inbox')).items[0].id;
  await call(maal, { method: 'POST', query: { action: 'resolve' }, headers: owner, body: { id, accept: false } });
  const again = await call(maal, { method: 'POST', query: { action: 'propose' }, headers: bearer, body: { key: body.payments[0].key, txId: 't1', amount: 292950 } });
  assert.equal(again.body.status, 'rejected-before');
  assert.equal(stored().accs[0].pays[0].status, 'overdue');
});

test('a wrong amount is refused even with automatic marking on', async () => {
  store.set('pt_maal_cfg', JSON.stringify({ autoMark: true }));
  const { body } = await call(maal, { query: { action: 'schedule' }, headers: bearer });
  const r = await call(maal, { method: 'POST', query: { action: 'propose' }, headers: bearer, body: { key: body.payments[0].key, txId: 't9', amount: 292949 } });
  assert.equal(r.body.status, 'refused');
  assert.equal(stored().accs[0].pays[0].status, 'overdue');
});

test('automatic marking writes one payment, and a newer save from another device wins', async () => {
  store.set('pt_maal_cfg', JSON.stringify({ autoMark: true }));
  const { body } = await call(maal, { query: { action: 'schedule' }, headers: bearer });
  const ok = await call(maal, { method: 'POST', query: { action: 'propose' }, headers: bearer, body: { key: body.payments[0].key, txId: 't1', amount: 292950 } });
  assert.equal(ok.body.status, 'marked');
  assert.equal(stored().accs[0].pays[0].status, 'paid');
});

test('if another device saves first, the Maal write is refused and the newer data is untouched', async () => {
  store.set('pt_maal_cfg', JSON.stringify({ autoMark: true }));
  const { body } = await call(maal, { query: { action: 'schedule' }, headers: bearer });
  const newer = { ...DATA, accs: [{ ...DATA.accs[0], name: 'Edited on laptop' }], saved: '2026-09-16T11:00:00.000Z' };
  beforeCas = () => {
    store.set('paytrack_data', JSON.stringify({ value: JSON.stringify(newer) }));
    store.set('pt_data_ver', String(Date.parse(newer.saved)));
  };
  const r = await call(maal, { method: 'POST', query: { action: 'propose' }, headers: bearer, body: { key: body.payments[0].key, txId: 't1', amount: 292950 } });
  assert.equal(r.status, 409);
  assert.equal(stored().accs[0].name, 'Edited on laptop');
  assert.equal(stored().accs[0].pays[0].status, 'overdue');
});

test('the car plan becomes one PayTrack account, once', async () => {
  const input = { maalId: 'nissan-1', name: 'Car nissan for new driver', monthlyAmount: 20000, months: 3, firstPayment: '2026-09-28', totalAmount: 60000 };
  const first = await call(maal, { method: 'POST', query: { action: 'plan' }, headers: bearer, body: input });
  assert.equal(first.body.status, 'created');
  const second = await call(maal, { method: 'POST', query: { action: 'plan' }, headers: bearer, body: input });
  assert.equal(second.body.status, 'exists');
  const accs = stored().accs;
  assert.equal(accs.length, 2);
  assert.deepEqual(accs[1].pays.map((p) => p.dt), ['28-09-2026', '28-10-2026', '28-11-2026']);
  assert.equal(accs[0].pays.length, 2);
});

test('only the owner can make a key, and only its hash is stored', async () => {
  assert.equal((await call(maal, { method: 'POST', query: { action: 'new-key' }, headers: {} })).status, 401);
  const r = await call(maal, { method: 'POST', query: { action: 'new-key' }, headers: owner });
  assert.match(r.body.key, /^[a-f0-9]{64}$/);
  assert.equal(store.get('pt_maal_key'), sha(r.body.key));
  assert.equal((await call(maal, { query: { action: 'schedule' }, headers: bearer })).status, 401);
  assert.equal((await call(maal, { query: { action: 'schedule' }, headers: { authorization: 'Bearer ' + r.body.key } })).status, 200);
});
