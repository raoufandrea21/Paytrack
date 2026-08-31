import { guard } from './_auth.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!(await guard(req, res))) return;
  try {
    const { accs, stocks, savings, margins, baseVersion } = req.body;
    if (!accs || !Array.isArray(accs)) return res.status(400).json({ error: 'Invalid data' });
    const kv = process.env.KV_REST_API_URL;
    const token = process.env.KV_REST_API_TOKEN;
    if (!kv || !token) return res.status(500).json({ error: 'KV not configured' });

    // ── optimistic concurrency ────────────────────────────────────────────
    // A write must declare the version it is replacing. If the stored copy has
    // moved on since, the write is refused and the current copy is returned.
    // This is what makes a stale device structurally incapable of overwriting
    // newer data: it cannot know a version it has never read. Without it, every
    // code path that saves is another chance to clobber.
    // FAIL CLOSED. If we cannot read the current copy we cannot know whether
    // this write is stale, so we must refuse it -- not wave it through. The old
    // catch treated any read hiccup (rate limit, transient error, parse
    // failure) as "no stored copy" and skipped the version check entirely,
    // which let a stale device overwrite newer data whenever Upstash blinked.
    let current = null, storeEmpty = false;
    try {
      const cur = await fetch(`${kv}/get/paytrack_data`, { headers: { Authorization: `Bearer ${token}` } });
      if (!cur.ok) throw new Error('conflict-read ' + cur.status);
      const cj = await cur.json();
      if (cj.result == null) storeEmpty = true;
      else {
        let parsed = JSON.parse(cj.result);
        if (parsed && typeof parsed.value === 'string') parsed = JSON.parse(parsed.value);
        current = parsed;
      }
    } catch (e) {
      return res.status(503).json({ error: 'Could not verify the current version; save refused. Try again.', detail: e.message });
    }
    if (current == null && !storeEmpty) {
      return res.status(503).json({ error: 'Could not verify the current version; save refused. Try again.' });
    }

    if (current && current.saved) {
      const storedVersion = new Date(current.saved).getTime();
      const claimed = baseVersion ? new Date(+baseVersion || baseVersion).getTime() : null;
      if (!claimed || claimed !== storedVersion) {
        return res.status(409).json({
          error: 'Version conflict',
          storedVersion,
          claimedVersion: claimed,
          current
        });
      }
    }
    const data = JSON.stringify({ 
      accs, 
      stocks: stocks || [], 
      savings: savings || [], 
      margins: margins || {}, 
      saved: new Date().toISOString() 
    });
    const r = await fetch(`${kv}/set/paytrack_data`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: data })
    });
    if (!r.ok) throw new Error('KV write failed: ' + r.status);
    // Audit trail: who wrote, from which base. Best effort -- a failure here
    // must never fail the save itself.
    try {
      const lg = await fetch(`${kv}/get/pt_write_log`, { headers: { Authorization: `Bearer ${token}` } });
      let list = [];
      if (lg.ok) { const lj = await lg.json(); if (lj.result) { try { list = JSON.parse(lj.result); } catch (e) {} } }
      if (!Array.isArray(list)) list = [];
      list.push({ t: new Date().toISOString(), dev: String(req.body.dev || 'unknown').slice(0, 40),
                  base: baseVersion || null,
                  accs: accs.length,
                  paid: accs.reduce((n, a) => n + (a.pays || []).filter(x => x.status === 'paid').length, 0) });
      while (list.length > 30) list.shift();
      await fetch(`${kv}/set/pt_write_log`, { method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain' },
        body: JSON.stringify(list) });
    } catch (e) {}
    return res.status(200).json({ success: true, accounts: accs.length, saved: new Date().toISOString() });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}