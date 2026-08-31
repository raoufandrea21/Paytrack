import { guard } from './_auth.js';

// Atomic versioned write.
//
// Two defects lived here. (1) The stored copy was stamped with one new Date()
// and the response with ANOTHER, taken after two audit round-trips, so the
// client recorded a version the server never stored -- every following save
// spuriously conflicted and the client dropped the user's edit. One timestamp
// now serves both. (2) The read-check-write was not atomic, so two overlapping
// saves could both pass the check and the later one silently won. The
// check-and-write now happens in a single Lua script on Redis, keyed by a
// dedicated version counter, so exactly one writer can succeed per version.

const CAS_LUA =
  "local v = redis.call('GET', KEYS[1]) " +
  "if ((v == false) and (ARGV[1] == '')) or (v == ARGV[1]) then " +
  "redis.call('SET', KEYS[1], ARGV[2]) redis.call('SET', KEYS[2], ARGV[3]) return 1 " +
  "else return 0 end";

async function kvCmd(kv, token, cmd) {
  const r = await fetch(kv, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd)
  });
  if (!r.ok) throw new Error('kv ' + cmd[0] + ' ' + r.status);
  return (await r.json()).result;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!(await guard(req, res))) return;
  try {
    const { accs, stocks, savings, margins, baseVersion, dev } = req.body;
    if (!accs || !Array.isArray(accs)) return res.status(400).json({ error: 'Invalid data' });
    const kv = process.env.KV_REST_API_URL;
    const token = process.env.KV_REST_API_TOKEN;
    if (!kv || !token) return res.status(500).json({ error: 'KV not configured' });

    // FAIL CLOSED: if the current copy cannot be read, refuse rather than
    // guess whether this write is stale. The client retries on its own.
    let current = null, storeEmpty = false;
    try {
      const raw = await kvCmd(kv, token, ['GET', 'paytrack_data']);
      if (raw == null) storeEmpty = true;
      else {
        let parsed = JSON.parse(raw);
        if (parsed && typeof parsed.value === 'string') parsed = JSON.parse(parsed.value);
        current = parsed;
      }
    } catch (e) {
      return res.status(503).json({ error: 'Could not verify the current version; save refused. Try again.', detail: e.message });
    }

    // Initialise the version counter from a pre-CAS copy, exactly once.
    if (current && current.saved) {
      try { await kvCmd(kv, token, ['SETNX', 'pt_data_ver', String(new Date(current.saved).getTime())]); }
      catch (e) { return res.status(503).json({ error: 'Could not verify the current version; save refused. Try again.' }); }
    }

    const claimed = baseVersion ? String(new Date(+baseVersion || baseVersion).getTime()) : '';
    const savedIso = new Date().toISOString();          // the ONE timestamp
    const savedMs = String(new Date(savedIso).getTime());
    const payload = JSON.stringify({
      value: JSON.stringify({ accs, stocks: stocks || [], savings: savings || [], margins: margins || {}, saved: savedIso })
    });

    let win;
    try {
      win = await kvCmd(kv, token, ['EVAL', CAS_LUA, '2', 'pt_data_ver', 'paytrack_data', claimed, savedMs, payload]);
    } catch (e) {
      return res.status(503).json({ error: 'Could not verify the current version; save refused. Try again.', detail: e.message });
    }

    if (win !== 1) {
      return res.status(409).json({
        error: 'Version conflict',
        storedVersion: current && current.saved ? new Date(current.saved).getTime() : null,
        claimedVersion: claimed ? +claimed : null,
        current
      });
    }

    // Audit trail: best effort, never fails the save.
    try {
      let list = [];
      const lg = await kvCmd(kv, token, ['GET', 'pt_write_log']);
      if (lg) { try { list = JSON.parse(lg); } catch (e) {} }
      if (!Array.isArray(list)) list = [];
      list.push({ t: savedIso, dev: String(dev || 'unknown').slice(0, 40), base: baseVersion || null,
                  accs: accs.length,
                  paid: accs.reduce((n, a) => n + (a.pays || []).filter(x => x.status === 'paid').length, 0) });
      while (list.length > 30) list.shift();
      await kvCmd(kv, token, ['SET', 'pt_write_log', JSON.stringify(list)]);
    } catch (e) {}

    // Return EXACTLY what was stored, so the client's version always matches.
    return res.status(200).json({ success: true, accounts: accs.length, saved: savedIso });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
