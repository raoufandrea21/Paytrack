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
    let current = null;
    try {
      const cur = await fetch(`${kv}/get/paytrack_data`, { headers: { Authorization: `Bearer ${token}` } });
      if (cur.ok) {
        const cj = await cur.json();
        if (cj.result) {
          let parsed = JSON.parse(cj.result);
          if (parsed && typeof parsed.value === 'string') parsed = JSON.parse(parsed.value);
          current = parsed;
        }
      }
    } catch (e) { /* treat as no stored copy */ }

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
    return res.status(200).json({ success: true, accounts: accs.length, saved: new Date().toISOString() });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}