import { guard } from './_auth.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!(await guard(req, res))) return;
  try {
    const kv = process.env.KV_REST_API_URL;
    const token = process.env.KV_REST_API_TOKEN;
    if (!kv || !token) return res.status(200).json({ error: 'KV not configured' });

    // One request for both: the data, and what Maal has proposed. Reading them
    // together costs the same as reading the data alone did.
    const r = await fetch(kv, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(['MGET', 'paytrack_data', 'pt_maal_inbox'])
    });
    if (!r.ok) return res.status(200).json({ error: 'KV read failed' });

    const json = await r.json();
    const [raw, inboxRaw] = Array.isArray(json.result) ? json.result : [];
    if (!raw) return res.status(200).json({ error: 'No data' });
    const data = JSON.parse(raw);
    let maalInbox = [];
    try { maalInbox = (JSON.parse(inboxRaw || '{}').items) || []; } catch (e) {}
    return res.status(200).json({ ...data, maalInbox });
  } catch (e) {
    return res.status(200).json({ error: e.message });
  }
}
