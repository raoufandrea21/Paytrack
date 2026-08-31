// Stores the device's push subscription in KV so the cron can send to it.
import { guard } from './_auth.js';

export default async function handler(req, res) {
  if (!(await guard(req, res))) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  try {
    const sub = req.body;
    if (!sub || !sub.endpoint) return res.status(400).json({ error: 'bad subscription' });
    const KV_URL = process.env.KV_REST_API_URL, KV_TOKEN = process.env.KV_REST_API_TOKEN;
    // store under a set of subscriptions (keyed by endpoint hash for dedupe)
    const key = 'pt_push_' + Buffer.from(sub.endpoint).toString('base64').slice(-24).replace(/[^a-zA-Z0-9]/g,'');
    // Upstash stores the request body AS the value. Wrapping it in {"value":...}
    // stored the wrapper, so the cron sender unwrapped garbage and silently
    // pushed to nobody.
    await fetch(`${KV_URL}/set/${key}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'text/plain' },
      body: JSON.stringify(sub)
    });
    // maintain an index list
    await fetch(`${KV_URL}/sadd/pt_push_index/${key}`, {
      method: 'POST', headers: { Authorization: `Bearer ${KV_TOKEN}` }
    });
    res.status(200).json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
