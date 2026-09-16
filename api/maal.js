import crypto from 'node:crypto';
import { guard, kvCmd, usageKey } from './_auth.js';
import { scheduleView, checkProposal, markPaid, addToInbox, upsertPlan, findPayment, toIso, effDate } from './_maal_core.js';

// The link to Maal, the phone app that reads bank messages.
//
// Two callers, two ways in:
//  - Maal itself, with a key created here and sent as "Authorization: Bearer".
//    It can read the schedule, propose a match, and add a plan it converted.
//  - This web app, with the normal passcode session, to make or revoke the key,
//    switch automatic marking on or off, and accept or reject a proposal.
//
// Safety, in order of importance:
//  1. Nothing Maal sends changes a payment unless automatic marking is on. A
//     proposal goes into its own record (pt_maal_inbox), not into the data.
//  2. Every change to the data is ONE payment or ONE new account, written with
//     the same version check /api/save uses, so it can never overwrite an edit
//     another device made in the meantime.
//  3. Database requests are counted: a Maal read is one request.

const KEY_HASH = 'pt_maal_key';
const CFG = 'pt_maal_cfg';
const INBOX = 'pt_maal_inbox';
const DATA = 'paytrack_data';
const VER = 'pt_data_ver';

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

// One request: check the key, count the request, and read everything a Maal
// call needs.
const MAAL_GATE_LUA =
  "local k = redis.call('GET', KEYS[1]) " +
  "local c = redis.call('INCR', KEYS[2]) " +
  "if c == 1 then redis.call('EXPIRE', KEYS[2], 3024000) end " +
  "if (not k) or k ~= ARGV[1] then return {0} end " +
  "return {1, redis.call('GET', KEYS[3]) or '', redis.call('GET', KEYS[4]) or '', redis.call('GET', KEYS[5]) or '', redis.call('GET', KEYS[6]) or ''}";

// The same compare-and-set as /api/save: the write lands only if the version
// is still the one this change was made against.
const CAS_LUA =
  "local v = redis.call('GET', KEYS[1]) " +
  "if ((v == false) and (ARGV[1] == '')) or (v == ARGV[1]) then " +
  "redis.call('SET', KEYS[1], ARGV[2]) redis.call('SET', KEYS[2], ARGV[3]) return 1 " +
  "else return 0 end";

function parseData(raw) {
  if (!raw) return null;
  let parsed = JSON.parse(raw);
  if (parsed && typeof parsed.value === 'string') parsed = JSON.parse(parsed.value);
  return parsed;
}
const parseJson = (raw, fallback) => {
  try { return raw ? JSON.parse(raw) : fallback; } catch (e) { return fallback; }
};
const inboxOf = (raw) => {
  const v = parseJson(raw, {});
  return { items: Array.isArray(v.items) ? v.items : [], rejected: Array.isArray(v.rejected) ? v.rejected : [] };
};

async function readAll() {
  const [raw, ver, cfg, inbox] = await kvCmd(['MGET', DATA, VER, CFG, INBOX]);
  return { data: parseData(raw), ver: ver || '', cfg: parseJson(cfg, {}), inbox: inboxOf(inbox), raw };
}

// Apply one change to the data and write it with the version check. `change`
// mutates `data` and returns what to report; it throws to refuse.
async function writeData(data, ver, change, who) {
  if (!data || !Array.isArray(data.accs) || !data.accs.length) throw Object.assign(new Error('no-data'), { status: 503 });
  // A copy written before versions existed: initialise the counter exactly as /api/save does.
  if (!ver && data.saved) {
    await kvCmd(['SETNX', VER, String(new Date(data.saved).getTime())]);
    ver = (await kvCmd(['GET', VER])) || '';
  }
  const result = change(data);
  const savedIso = new Date().toISOString();
  const payload = JSON.stringify({ value: JSON.stringify({ ...data, saved: savedIso }) });
  const win = await kvCmd(['EVAL', CAS_LUA, '2', VER, DATA, ver, String(Date.parse(savedIso)), payload]);
  if (win !== 1) throw Object.assign(new Error('version-conflict'), { status: 409 });
  // Audit, best effort, the same record /api/save keeps.
  try {
    let list = parseJson(await kvCmd(['GET', 'pt_write_log']), []);
    if (!Array.isArray(list)) list = [];
    list.push({ t: savedIso, dev: who, base: ver || null, accs: data.accs.length, paid: data.accs.reduce((n, a) => n + (a.pays || []).filter((x) => x.status === 'paid').length, 0) });
    while (list.length > 30) list.shift();
    await kvCmd(['SET', 'pt_write_log', JSON.stringify(list)]);
  } catch (e) {}
  return { result, saved: savedIso };
}

function send(res, status, body) {
  return res.status(status).json(body);
}

// ── Maal's side ──────────────────────────────────────────────────────────
async function maalCall(req, res, action) {
  const auth = String(req.headers.authorization || '');
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!/^[a-f0-9]{64}$/.test(token)) return send(res, 401, { error: 'Not authorised' });
  let gate;
  try {
    gate = await kvCmd(['EVAL', MAAL_GATE_LUA, '6', KEY_HASH, usageKey(), CFG, DATA, VER, INBOX, sha(token)]);
  } catch (e) {
    return send(res, 503, { error: 'Database unavailable' });
  }
  if (!gate || gate[0] !== 1) return send(res, 401, { error: 'Not authorised' });
  const cfg = parseJson(gate[1], {});
  let data;
  try { data = parseData(gate[2]); } catch (e) { return send(res, 503, { error: 'Data unreadable' }); }
  const ver = gate[3] || '';
  const inbox = inboxOf(gate[4]);
  const autoMark = cfg.autoMark === true;

  if (req.method === 'GET' && action === 'schedule') {
    const today = new Date().toISOString().slice(0, 10);
    const view = data ? scheduleView(data, today) : { accounts: [], payments: [] };
    return send(res, 200, {
      version: data && data.saved ? Date.parse(data.saved) : null,
      autoMark,
      pending: inbox.items.map((x) => x.txId),
      // The payments those proposals are for: the money has left the bank, so a forecast must not take it again.
      pendingKeys: inbox.items.map((x) => x.key),
      rejected: inbox.rejected,
      ...view,
    });
  }

  if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' });
  const body = req.body || {};

  if (action === 'propose') {
    if (!data) return send(res, 503, { error: 'No data' });
    const prop = { key: String(body.key || ''), txId: String(body.txId || ''), amount: Number(body.amount), date: body.date, merchant: body.merchant, bank: body.bank };
    if (!prop.key || !prop.txId || !(prop.amount > 0)) return send(res, 400, { error: 'Invalid proposal' });
    if (inbox.rejected.includes(prop.txId)) return send(res, 200, { status: 'rejected-before' });
    const check = checkProposal(data, prop);
    if (!check.ok) return send(res, 200, { status: 'refused', reason: check.reason });
    if (autoMark) {
      try {
        await writeData(data, ver, (d) => markPaid(d, prop.key), 'maal-auto');
        return send(res, 200, { status: 'marked' });
      } catch (e) {
        return send(res, e.status || 500, { error: e.message });
      }
    }
    const { acc, p } = check.hit;
    const { list, added } = addToInbox(inbox.items, { ...prop, accName: acc.name, desc: p.desc, dueDate: toIso(effDate(p)) }, new Date().toISOString());
    if (added) await kvCmd(['SET', INBOX, JSON.stringify({ items: list, rejected: inbox.rejected })]);
    return send(res, 200, { status: 'pending' });
  }

  if (action === 'plan') {
    if (!data) return send(res, 503, { error: 'No data' });
    try {
      const out = await writeDataIfNew(data, ver, body);
      return send(res, 200, out);
    } catch (e) {
      return send(res, e.status || 400, { error: e.message });
    }
  }

  return send(res, 400, { error: 'Unknown action' });
}

async function writeDataIfNew(data, ver, input) {
  const existing = (data.accs || []).find((a) => a.maalId && a.maalId === String(input.maalId));
  if (existing) return { status: 'exists', accId: existing.id };
  const { result } = await writeData(data, ver, (d) => upsertPlan(d, input), 'maal-plan');
  return { status: result.created ? 'created' : 'exists', accId: result.acc.id };
}

// ── PayTrack's side ──────────────────────────────────────────────────────
async function ownerCall(req, res, action) {
  if (!(await guard(req, res))) return;
  const body = req.body || {};
  let state;
  try { state = await readAll(); } catch (e) { return send(res, 503, { error: 'Database unavailable' }); }

  if (action === 'status') {
    const key = await kvCmd(['EXISTS', KEY_HASH]);
    return send(res, 200, { connected: key === 1, autoMark: state.cfg.autoMark === true, pending: state.inbox.items.length, createdAt: state.cfg.keyCreatedAt || null });
  }
  if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' });

  if (action === 'new-key') {
    // Shown once. Only its hash is kept, so a leaked database copy cannot be used as a key.
    const key = crypto.randomBytes(32).toString('hex');
    await kvCmd(['SET', KEY_HASH, sha(key)]);
    await kvCmd(['SET', CFG, JSON.stringify({ ...state.cfg, keyCreatedAt: new Date().toISOString() })]);
    return send(res, 200, { key });
  }
  if (action === 'revoke') {
    await kvCmd(['DEL', KEY_HASH]);
    return send(res, 200, { ok: true });
  }
  if (action === 'config') {
    const cfg = { ...state.cfg, autoMark: body.autoMark === true };
    await kvCmd(['SET', CFG, JSON.stringify(cfg)]);
    return send(res, 200, { autoMark: cfg.autoMark });
  }
  if (action === 'resolve') {
    const item = state.inbox.items.find((x) => x.id === body.id);
    if (!item) return send(res, 404, { error: 'Already handled' });
    const rest = state.inbox.items.filter((x) => x.id !== item.id);
    if (body.accept === true) {
      const check = checkProposal(state.data || { accs: [] }, item);
      if (check.ok) {
        try {
          await writeData(state.data, state.ver, (d) => markPaid(d, item.key), 'maal-confirmed');
        } catch (e) {
          return send(res, e.status || 500, { error: e.message });
        }
      }
      await kvCmd(['SET', INBOX, JSON.stringify({ items: rest, rejected: state.inbox.rejected })]);
      return send(res, 200, { status: check.ok ? 'marked' : 'stale', reason: check.ok ? null : check.reason });
    }
    const rejected = [...state.inbox.rejected, item.txId].slice(-200);
    await kvCmd(['SET', INBOX, JSON.stringify({ items: rest, rejected })]);
    return send(res, 200, { status: 'rejected' });
  }
  return send(res, 400, { error: 'Unknown action' });
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  const action = String((req.query && req.query.action) || '');
  const kv = process.env.KV_REST_API_URL, token = process.env.KV_REST_API_TOKEN;
  if (!kv || !token) return send(res, 500, { error: 'KV not configured' });
  try {
    if (['schedule', 'propose', 'plan'].includes(action)) return await maalCall(req, res, action);
    return await ownerCall(req, res, action);
  } catch (e) {
    return send(res, 500, { error: e.message });
  }
}

export { findPayment };
