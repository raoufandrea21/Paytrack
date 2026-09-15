// Daily cron (8:00 GST = 4:00 UTC): finds payments due today or within each
// account's remDays window, sends a push notification per payment.
// Uses the web-push library — add to package.json: "web-push": "^3.6.7"
import webpush from 'web-push';

function pd(s) {
  if (!s) return null;
  const a = ('' + s).trim().match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (a) return new Date(+a[3], +a[2] - 1, +a[1]);
  return null;
}
const eff = p => (p.nd && p.nd.trim()) ? p.nd : p.dt;

export default async function handler(req, res) {
  // Vercel's cron sends Authorization: Bearer CRON_SECRET automatically once
  // the env var exists. Without this check anyone could trigger push sends.
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers['authorization'] !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const KV_URL = process.env.KV_REST_API_URL, KV_TOKEN = process.env.KV_REST_API_TOKEN;
    webpush.setVapidDetails(
      'mailto:mr.raouf@gmail.com',
      process.env.VAPID_PUBLIC_KEY,
      process.env.VAPID_PRIVATE_KEY
    );

    // 1. Load app state
    const stateRes = await fetch(`${KV_URL}/get/paytrack_data`, { headers: { Authorization: `Bearer ${KV_TOKEN}` } });
    const stateJson = await stateRes.json();
    if (!stateJson.result) return res.status(200).json({ ok: true, note: 'no state' });
    let state = JSON.parse(stateJson.result);
    // save.js writes the body as the value, so it comes back wrapped
    if (state && typeof state.value === 'string') state = JSON.parse(state.value);
    const accs = state.accs || [];

    // 2. Find payments due (today or within remDays)
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const due = [];
    accs.forEach(a => {
      const rem = a.remDays || 7;
      (a.pays || []).forEach((p, i) => {
        if (p.status === 'paid') return;
        const d = pd(eff(p));
        if (!d) return;
        const days = Math.round((d - today) / 86400000);
        if (days === 0) due.push({ a, p, i, when: 'TODAY' });
        else if (days > 0 && days <= rem) due.push({ a, p, i, when: 'in ' + days + ' day' + (days > 1 ? 's' : '') });
      });
    });

    // Database usage alarm. The free plan allows 500K requests a month and
    // running out locks the app, as happened in September 2026. Normal use is
    // a few hundred gated requests a day; warn well before the limit.
    const USAGE_ALERT = 3000;
    let usageAlert = null;
    try {
      const y = new Date(Date.now() - 86400000);
      const key = 'pt_usage_' + y.toISOString().slice(0, 10).replace(/-/g, '');
      const u = await fetch(`${KV_URL}/get/${key}`, { headers: { Authorization: `Bearer ${KV_TOKEN}` } });
      const n = +((await u.json()).result || 0);
      if (n > USAGE_ALERT) usageAlert = n;
    } catch (e) {}

    if (!due.length && !usageAlert) return res.status(200).json({ ok: true, sent: 0 });

    // 3. Load subscriptions
    const idxRes = await fetch(`${KV_URL}/smembers/pt_push_index`, { headers: { Authorization: `Bearer ${KV_TOKEN}` } });
    const idx = (await idxRes.json()).result || [];
    const subs = [];
    for (const key of idx) {
      const r = await fetch(`${KV_URL}/get/${key}`, { headers: { Authorization: `Bearer ${KV_TOKEN}` } });
      const j = await r.json();
      if (j.result) { try {
        let sub = JSON.parse(j.result);
        if (sub && typeof sub.value === 'string') sub = JSON.parse(sub.value);  // legacy wrapped shape
        if (sub && sub.endpoint) subs.push(sub);
      } catch (e) {} }
    }
    if (!subs.length) return res.status(200).json({ ok: true, note: 'no subscribers', due: due.length });

    // 4. Send one notification per due payment to every device
    let sent = 0;
    if (usageAlert) {
      const payload = JSON.stringify({
        title: '⚠️ PayTrack server use is high',
        body: `${usageAlert.toLocaleString()} requests yesterday (normal is a few hundred). Close extra PayTrack windows and remove any phone widget.`,
        tag: 'pt-usage', url: '/'
      });
      for (const sub of subs) {
        try { await webpush.sendNotification(sub, payload); sent++; } catch (e) {}
      }
    }
    for (const d of due) {
      const fmtAmt = 'AED ' + Math.round(d.p.amount).toLocaleString();
      const payload = JSON.stringify({
        title: d.when === 'TODAY' ? `💳 Due today: ${d.a.name}` : `🔔 ${d.a.name} — due ${d.when}`,
        body: `${d.p.desc} · ${fmtAmt}${d.p.chq ? ' · Chq ' + d.p.chq : ''}`,
        tag: `pt-${d.a.id}-${d.i}`,
        accId: d.a.id,
        payIdx: d.i,
        url: '/'
      });
      for (const sub of subs) {
        try { await webpush.sendNotification(sub, payload); sent++; }
        catch (e) { /* expired subscription — ignore */ }
      }
    }
    res.status(200).json({ ok: true, due: due.length, sent });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
