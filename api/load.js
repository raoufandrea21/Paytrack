export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const kv = process.env.KV_REST_API_URL;
    const token = process.env.KV_REST_API_TOKEN;
    if (!kv || !token) return res.status(200).json({ error: 'KV not configured' });

    const r = await fetch(`${kv}/get/paytrack_data`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!r.ok) return res.status(200).json({ error: 'KV read failed' });

    const json = await r.json();
    if (!json.result) return res.status(200).json({ error: 'No data in KV' });

    const data = JSON.parse(json.result);
    return res.status(200).json(data);
  } catch (e) {
    return res.status(200).json({ error: e.message });
  }
}
