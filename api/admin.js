// Owner admin actions, one function to stay inside Vercel's 12-function cap:
//   ?action=recover    restore data lost to the 31-08 sync bug (idempotent)
//   ?action=writes     server-side audit of who wrote what
//   ?action=test-push  send a test notification to every registered device
// All session-guarded.

import webpush from 'web-push';
import { guard, kvGet } from './_auth.js';

async function doRecover(res) {
  try {
    const kv = process.env.KV_REST_API_URL, token = process.env.KV_REST_API_TOKEN;
    const raw = await kvGet('paytrack_data');
    if (!raw) return res.status(200).json({ error: 'No data stored.' });
    let data = JSON.parse(raw);
    if (data && typeof data.value === 'string') data = JSON.parse(data.value);
    if (!Array.isArray(data.accs)) return res.status(200).json({ error: 'Unexpected data shape.' });

    const done = [];

    if (!data.accs.some(a => a.id === 'ammar' || a.name === 'Ammar')) {
      data.accs.push({
        id: 'ammar', name: 'Ammar', type: 'Lender', principal: 40500,
        url: '', defer: false, remDays: 1,
        pays: [
          { desc: '1st installment', status: 'notpaid', amount: 11500, dt: '01-09-2026', nd: '', chq: '' },
          { desc: '2nd installment', status: 'notpaid', amount: 11500, dt: '01-10-2026', nd: '', chq: '' },
          { desc: '3rd installment', status: 'notpaid', amount: 11500, dt: '01-11-2026', nd: '', chq: '' }
        ]
      });
      done.push('Ammar account restored (40,500 across 3 instalments)');
    } else done.push('Ammar already present — untouched');

    const markPaid = (accId, descStart) => {
      const a = data.accs.find(x => x.id === accId);
      if (!a) return;
      const p = (a.pays || []).find(x => String(x.desc || '').startsWith(descStart));
      if (p && p.status !== 'paid') {
        p.status = 'paid';
        done.push(a.name + ' — "' + p.desc + '" marked paid');
      } else if (p) done.push(a.name + ' — "' + p.desc + '" already paid');
    };
    markPaid('nawayef', 'Commencement of Construction');
    markPaid('mayar', '50% of foundation works');

    data.saved = new Date().toISOString();
    const w = await fetch(`${kv}/set/paytrack_data`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain' },
      body: JSON.stringify({ value: JSON.stringify(data) })
    });
    if (!w.ok) throw new Error('write failed ' + w.status);

    return res.status(200).json({ ok: true, done, savedAt: data.saved,
      note: 'Now hard-refresh PayTrack on the PC; it will adopt this version.' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

async function doTestPush(res) {
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

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!(await guard(req, res))) return;
  const action = (req.query && req.query.action) || '';
  if (action === 'recover') return doRecover(res);
  if (action === 'test-push') return doTestPush(res);
  if (action === 'writes') {
    try {
      const raw = await kvGet('pt_write_log');
      return res.status(200).json({ writes: raw ? JSON.parse(raw) : [] });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }
  return res.status(400).json({ error: 'Unknown action' });
}
