export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const { accs, stocks } = req.body;
    if (!accs || !Array.isArray(accs)) return res.status(400).json({ error: 'Invalid data' });
    const kv = process.env.KV_REST_API_URL;
    const token = process.env.KV_REST_API_TOKEN;
    if (!kv || !token) return res.status(500).json({ error: 'KV not configured' });
    const data = JSON.stringify({ accs, stocks: stocks || [], saved: new Date().toISOString() });
    const r = await fetch(`${kv}/set/paytrack_data`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: data })
    });
    if (!r.ok) throw new Error('KV write failed: ' + r.status);
    return res.status(200).json({ success: true, accounts: accs.length });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
