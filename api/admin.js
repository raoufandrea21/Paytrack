// Owner admin actions, one function to stay inside Vercel's 12-function cap:
//   ?action=recover    restore data lost to the 31-08 sync bug (idempotent)
//   ?action=writes     server-side audit of who wrote what
//   ?action=test-push  send a test notification to every registered device
// All session-guarded.

import crypto from 'node:crypto';
import webpush from 'web-push';
import { guard, kvGet, kvSet } from './_auth.js';
import { buildCFOContext, parseDate, effDate, isOwed } from './_cfo.js';

async function doRecover(res) {
  try {
    const kv = process.env.KV_REST_API_URL, token = process.env.KV_REST_API_TOKEN;
    const raw = await kvGet('paytrack_data');
    if (!raw) return res.status(200).json({ error: 'No data stored.' });
    let data = JSON.parse(raw);
    if (data && typeof data.value === 'string') data = JSON.parse(data.value);
    if (!Array.isArray(data.accs)) return res.status(200).json({ error: 'Unexpected data shape.' });

    const done = [];

    if (!data.accs.some(a => a.id === 'ammar' || a.id === 'ammar2026' || a.name === 'Ammar')) {
      // Fresh id: a device may still hold a deletion tombstone for 'ammar'
      // (they survive PWA reinstalls), which would filter the account out and
      // push its deletion server-wide again on that device's next save.
      data.accs.push({
        id: 'ammar2026', name: 'Ammar', type: 'Lender', principal: 40500,
        url: '', defer: false, remDays: 1,
        pays: [
          { desc: '1st installment', status: 'notpaid', amount: 13500, dt: '01-09-2026', nd: '', chq: '' },
          { desc: '2nd installment', status: 'notpaid', amount: 13500, dt: '01-10-2026', nd: '', chq: '' },
          { desc: '3rd installment', status: 'notpaid', amount: 13500, dt: '01-11-2026', nd: '', chq: '' }
        ]
      });
      done.push('Ammar account restored (40,500 across 3 instalments)');
    } else {
      // Correct the amounts if an earlier pass (or the original entry) used
      // 11,500: three instalments of 13,500 equal the 40,500 principal exactly.
      const am = data.accs.find(x => x.id === 'ammar' || x.name === 'Ammar');
      let fixed = 0;
      (am.pays || []).forEach(p => {
        if (p.amount === 11500 && /installment/i.test(p.desc || '')) { p.amount = 13500; fixed++; }
      });
      done.push(fixed ? ('Ammar instalments corrected to 13,500 (' + fixed + ' rows)') : 'Ammar already present — untouched');
    }

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

    // No changes -> no write. Rewriting an identical copy still bumped the
    // version, which forced every device stale and made their next dirty save
    // conflict and drop an edit.
    const changed = done.some(m => !/already|untouched/.test(m));
    if (!changed) {
      return res.status(200).json({ ok: true, done, note: 'Nothing to change; nothing written.' });
    }

    // Write through the same atomic compare-and-set as /api/save, claiming the
    // version this copy was read at, so a save landing meanwhile wins and this
    // recovery is refused instead of silently erasing it.
    const claimed = data.saved ? String(new Date(data.saved).getTime()) : '';
    if (claimed) {
      await fetch(kv, { method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(['SETNX', 'pt_data_ver', claimed]) });
    }
    const savedIso = new Date().toISOString();
    data.saved = savedIso;
    const CAS_LUA =
      "local v = redis.call('GET', KEYS[1]) " +
      "if ((v == false) and (ARGV[1] == '')) or (v == ARGV[1]) then " +
      "redis.call('SET', KEYS[1], ARGV[2]) redis.call('SET', KEYS[2], ARGV[3]) return 1 " +
      "else return 0 end";
    const w = await fetch(kv, { method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(['EVAL', CAS_LUA, '2', 'pt_data_ver', 'paytrack_data',
        claimed, String(new Date(savedIso).getTime()),
        JSON.stringify({ value: JSON.stringify(data) })]) });
    if (!w.ok) throw new Error('write failed ' + w.status);
    const win = (await w.json()).result;
    if (win !== 1) {
      return res.status(409).json({ error: 'A device saved while recovering. Nothing was overwritten — just open this URL again.' });
    }

    return res.status(200).json({ ok: true, done, savedAt: savedIso,
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

// ── home-screen widget feed ───────────────────────────────────────────────
// A widget app (KWGT) cannot hold the passcode session, so this one action is
// authenticated by a random capability token instead: minted only from an
// unlocked session (?action=widget-token), checked in constant time, and
// rotatable at will. It serves a SUMMARY (totals, next payment), never the
// full records, and every other action stays session-guarded.
const fmtAED = n => 'AED ' + Math.round(n || 0).toLocaleString('en-US');

async function doWidget(req, res) {
  try {
    const stored = await kvGet('pt_widget_token');
    const given = String((req.query && req.query.token) || '');
    if (!stored) return res.status(403).json({ error: 'Widget feed not enabled. Open ?action=widget-token in the app first.' });
    const okTok = stored.length === given.length &&
      crypto.timingSafeEqual(Buffer.from(stored), Buffer.from(given));
    if (!okTok) return res.status(403).json({ error: 'Bad token' });

    const raw = await kvGet('paytrack_data');
    if (!raw) return res.status(200).json({ error: 'No data' });
    let data = JSON.parse(raw);
    if (data && typeof data.value === 'string') data = JSON.parse(data.value);
    const ctx = buildCFOContext(data);

    // soonest upcoming dated payment
    let next = null;
    (data.accs || []).forEach(a => (a.pays || []).forEach(p => {
      if (!isOwed(p)) return;
      const d = parseDate(effDate(p)); if (!d) return;
      const days = Math.round((d - new Date(new Date().setHours(0,0,0,0))) / 86400000);
      if (days < 0) return;
      if (!next || days < next.days) next = { days, account: a.name, desc: p.desc, amount: p.amount, date: effDate(p) };
    }));

    const o = ctx.obligations, s = ctx.summary;
    return res.status(200).json({
      updated: new Date().toISOString(),
      due30: o.next30, due30f: fmtAED(o.next30),
      due90: o.next90, due90f: fmtAED(o.next90),
      overdueCount: o.overdue.count, overdueValue: o.overdue.value,
      overduef: o.overdue.count ? (o.overdue.count + ' · ' + fmtAED(o.overdue.value)) : 'None',
      netWorth: s.netWorth, netWorthf: fmtAED(s.netWorth),
      portfolio: s.portfolioValue, portfoliof: fmtAED(s.portfolioValue),
      savings: s.savings, savingsf: fmtAED(s.savings),
      next: next ? {
        days: next.days, amount: next.amount, date: next.date,
        line: (next.days === 0 ? 'TODAY' : 'in ' + next.days + 'd') + ' · ' + next.account + ' · ' + fmtAED(next.amount)
      } : null,
      nextf: next ? ((next.days === 0 ? 'TODAY' : 'in ' + next.days + 'd') + ' · ' + next.account + ' · ' + fmtAED(next.amount)) : 'Nothing scheduled'
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const action = (req.query && req.query.action) || '';

  // token-authenticated, session-free: the widget feed only
  if (action === 'widget') return doWidget(req, res);

  if (!(await guard(req, res))) return;
  if (action === 'recover') return doRecover(res);
  if (action === 'test-push') return doTestPush(res);
  if (action === 'writes') {
    try {
      const raw = await kvGet('pt_write_log');
      return res.status(200).json({ writes: raw ? JSON.parse(raw) : [] });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }
  if (action === 'widget-token') {
    try {
      let tok = await kvGet('pt_widget_token');
      const rotate = req.query && req.query.rotate === '1';
      if (!tok || rotate) {
        tok = crypto.randomBytes(24).toString('hex');
        await kvSet('pt_widget_token', tok);
      }
      const url = 'https://paytrack-ashy.vercel.app/api/admin?action=widget&token=' + tok;
      return res.status(200).json({
        url,
        note: 'Paste this URL into your widget app. Anyone holding it can read your summary figures (not the full records) — keep it private. Add &rotate=1 to this page to invalidate it and mint a new one.'
      });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }
  return res.status(400).json({ error: 'Unknown action' });
}
