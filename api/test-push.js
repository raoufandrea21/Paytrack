// Sends one test notification to every registered device, so the push pipeline
// can be verified on demand instead of waiting for the next 08:00 cron run.
// Session-guarded: only the unlocked owner can trigger it.

import webpush from 'web-push';
import { guard } from './_auth.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!(await guard(req, res))) return;

  try {
    const KV_URL = process.env.KV_REST_API_URL, KV_TOKEN = process.env.KV_REST_API_TOKEN;
    if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) {
      return res.status(200).json({ error: 'VAPID keys are not configured.' });
    }
    webpush.setVapidDetails('mailto:mr.raouf@gmail.com',
      process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);

    const idxRes = await fetch(`${KV_URL}/smembers/pt_push_index`,
      { headers: { Authorization: `Bearer ${KV_TOKEN}` } });
    const idx = (await idxRes.json()).result || [];

    const subs = [];
    for (const key of idx) {
      const r = await fetch(`${KV_URL}/get/${key}`, { headers: { Authorization: `Bearer ${KV_TOKEN}` } });
      const j = await r.json();
      if (!j.result) continue;
      try {
        let sub = JSON.parse(j.result);
        if (sub && typeof sub.value === 'string') sub = JSON.parse(sub.value);  // legacy wrapped shape
        if (sub && sub.endpoint) subs.push({ key, sub });
      } catch (e) {}
    }

    if (!subs.length) {
      return res.status(200).json({
        subscribers: 0, sent: 0,
        note: 'No devices are registered for push. Open PayTrack unlocked with notifications allowed, then try again.'
      });
    }

    const payload = JSON.stringify({
      title: 'PayTrack test notification',
      body: 'Push is working on this device. Payment reminders will arrive like this at 08:00.',
      tag: 'pt-test', url: '/'
    });

    let sent = 0; const failures = [];
    for (const { key, sub } of subs) {
      try { await webpush.sendNotification(sub, payload); sent++; }
      catch (e) { failures.push({ key, status: e.statusCode || null, message: e.message }); }
    }
    return res.status(200).json({ subscribers: subs.length, sent, failures });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
