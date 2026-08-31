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
    if (!due.length) return res.status(200).json({ ok: true, sent: 0 });

    // 3. Load subscriptions
    const idxRes = await fetch(`${KV_URL}/smembers/pt_push_index`, { headers: { Authorization: `Bearer ${KV_TOKEN}` } });
    const idx = (await idxRes.json()).result || [];
    const subs = [];
    for (const key of idx) {
      const r = await fetch(`${KV_URL}/get/${key}`, { headers: { Authorization: `Bearer ${KV_TOKEN}` } });
      const j = await r.json();
      if (j.result) { try { subs.push(JSON.parse(j.result)); } catch (e) {} }
    }
    if (!subs.length) return res.status(200).json({ ok: true, note: 'no subscribers', due: due.length });

    // 4. Send one notification per due payment to every device
    let sent = 0;
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
