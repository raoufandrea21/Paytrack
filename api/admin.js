// Owner admin actions, one function to stay inside Vercel's 12-function cap:
//   ?action=recover    restore data lost to the 31-08 sync bug (idempotent)
//   ?action=writes     server-side audit of who wrote what
//   ?action=test-push  send a test notification to every registered device
// All session-guarded.

import crypto from 'node:crypto';
import webpush from 'web-push';
import { guard, kvGet, kvSet } from './_auth.js';
import { buildCFOContext, parseDate, effDate, isOwed } from './_cfo.js';

async function applyLiveWidgetQuotes(data) {
  const stocks = Array.isArray(data.stocks) ? data.stocks : [];
  const names = [...new Set(stocks.map(s => String(s.ticker || '').toUpperCase().trim()).filter(t => /^[A-Z0-9._-]{1,24}$/.test(t)))];
  if (!names.length) return;

  let cached = null;
  try { cached = JSON.parse(await kvGet('pt_widget_quotes') || 'null'); } catch (e) {}
  let quotes = cached && cached.quotes;

  if (!quotes || !names.every(t => quotes[t])) {
    try {
      const symbols = names.flatMap(t => [`ADX:${t}`, `DFM:${t}`]);
      const r = await fetch('https://scanner.tradingview.com/uae/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          symbols: { tickers: symbols, query: { types: [] } },
          columns: ['close', 'change', 'currency']
        })
      });
      if (r.ok) {
        const j = await r.json();
        quotes = {};
        (j.data || []).forEach(row => {
          const ticker = String(row.s || '').split(':').pop();
          const d = row.d || [], close = Number(d[0]), change = Number(d[1]);
          if (!ticker || !(close > 0)) return;
          quotes[ticker] = {
            price: close,
            prev: Number.isFinite(change) && change !== -100 ? close / (1 + change / 100) : null,
            currency: d[2] || 'AED'
          };
        });
        await kvSet('pt_widget_quotes', JSON.stringify({ quotes }), 300);
      }
    } catch (e) {}
  }

  const now = Date.now();
  stocks.forEach(st => {
    const q = quotes && quotes[String(st.ticker || '').toUpperCase().trim()];
    if (!q) return;
    st.cp = q.price;
    st.livePrice = q.price;
    st.liveAt = now;
    if (q.prev) st.prevClose = q.prev;
    if (q.currency) st.cur = q.currency;
  });
}

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
    await applyLiveWidgetQuotes(data);
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

    // ── per-stock rows ────────────────────────────────────────────────────
    // Margin is owed to a BROKERAGE ACCOUNT, not to a share. With one holding
    // per broker that distinction is invisible; with two it matters, so each
    // stock carries its share of its broker's margin in proportion to value.
    // That keeps the per-stock nets summing to the true total either way.
    const stocks = Array.isArray(data.stocks) ? data.stocks : [];
    const margins = (data.margins && typeof data.margins === 'object') ? data.margins : {};
    const brokerValue = {};
    stocks.forEach(st => {
      const b = String(st.broker || '').trim();
      brokerValue[b] = (brokerValue[b] || 0) + (st.qty || 0) * (st.cp || 0);
    });
    const rows = stocks.map(st => {
      const b = String(st.broker || '').trim();
      const value = (st.qty || 0) * (st.cp || 0);
      const bv = brokerValue[b] || 0;
      const share = (b && margins[b] && bv > 0) ? (+margins[b] * (value / bv)) : 0;
      const net = value - share;
      const dayPct = (st.prevClose && st.cp) ? ((st.cp - st.prevClose) / st.prevClose * 100) : null;
      const arrow = dayPct === null ? '' : (dayPct >= 0 ? '▲ +' : '▼ ');
      const ageMin = st.liveAt ? Math.round((Date.now() - st.liveAt) / 60000) : null;
      return {
        ticker: st.ticker, broker: b || null,
        price: st.cp || 0, pricef: (st.cur || 'AED') + ' ' + Number(st.cp || 0).toFixed(2),
        dayPct: dayPct === null ? null : +dayPct.toFixed(2),
        dayf: dayPct === null ? '—' : (arrow + Math.abs(dayPct).toFixed(2) + '%'),
        value, valuef: fmtAED(value),
        margin: Math.round(share), marginf: fmtAED(share),
        net: Math.round(net), netf: fmtAED(net),
        live: !!st.livePrice,
        // one ready-made line per stock, so the widget needs no formatting
        line: st.ticker + '  ' + Number(st.cp || 0).toFixed(2) + '  '
              + (dayPct === null ? '' : (arrow + Math.abs(dayPct).toFixed(2) + '%  '))
              + fmtAED(net),
        stale: ageMin !== null && ageMin > 60
      };
    });
    const stockNetTotal = rows.reduce((t, r) => t + r.net, 0);

    const o = ctx.obligations, s = ctx.summary;

    // Remaining unpaid obligations from today through the end of the
    // current Dubai calendar month. Deferred dates are respected by effDate.
    const dubai = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Dubai', year: 'numeric', month: 'numeric', day: 'numeric'
    }).formatToParts(new Date()).filter(p => p.type !== 'literal').map(p => [p.type, +p.value]));
    const monthStart = new Date(Date.UTC(dubai.year, dubai.month - 1, dubai.day));
    const monthEnd = new Date(Date.UTC(dubai.year, dubai.month, 0, 23, 59, 59));
    let monthPendingCount = 0, monthPendingAmount = 0;
    (data.accs || []).forEach(a => (a.pays || []).forEach(p => {
      if (!isOwed(p)) return;
      const d = parseDate(effDate(p));
      if (!d || d < monthStart || d > monthEnd) return;
      monthPendingCount++;
      monthPendingAmount += Number(p.amount) || 0;
    }));

    // -- one ready-made block ---------------------------------------------
    // So the widget needs a single text item and a single formula. Padded for
    // a monospace font so the columns line up; newlines render as line breaks
    // inside a KWGT text item.
    const pad = (str, n) => String(str).padEnd(n, ' ');
    const padL = (str, n) => String(str).padStart(n, ' ');
    const NLC = String.fromCharCode(10);
    const nextLine = next
      ? (next.days === 0 ? 'TODAY' : 'in ' + next.days + 'd') + ' · ' + next.account + ' · ' + fmtAED(next.amount)
      : 'Nothing scheduled';
    const stockLines = rows.map(r =>
      pad(r.ticker, 14) + pad(Number(r.price).toFixed(2), 6) + pad(r.dayf, 9) + padL(r.netf, 14)
    );
    const overdueLine = o.overdue.count
      ? ('⚠ OVERDUE ' + o.overdue.count + ' · ' + fmtAED(o.overdue.value) + NLC)
      : '';
    const all =
      'NEXT PAYMENT' + NLC + nextLine + NLC +
      overdueLine + NLC +
      stockLines.join(NLC) + NLC +
      pad('Net of margin', 14) + padL(fmtAED(stockNetTotal), 29) + NLC +
      'Updated ' + new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Dubai' });

    // compact variant for a 4x1 widget
    const compact = nextLine + NLC + pad('Stocks net', 14) + padL(fmtAED(stockNetTotal), 20);

    // A single plain-text response is the most reliable KWGT data source.
    if ((req.query && req.query.format) === 'text') {
      const field = String(req.query.field || '');
      const first = rows[0] || {};
      const second = rows[1] || {};
      const fields = {
        paymentName: next ? next.account : 'Nothing scheduled',
        paymentCountdown: next ? (next.days === 0 ? 'DUE TODAY' : 'IN ' + next.days + ' DAYS') : 'CLEAR',
        paymentAmount: next ? fmtAED(next.amount) : '—',
        monthPending: monthPendingCount + (monthPendingCount === 1 ? ' PENDING · ' : ' PENDING · ') + fmtAED(monthPendingAmount),
        stock1Ticker: first.ticker || '', stock1Price: first.pricef || '',
        stock1Day: first.dayf || '', stock1Net: first.netf || '',
        stock2Ticker: second.ticker || '', stock2Price: second.pricef || '',
        stock2Day: second.dayf || '', stock2Net: second.netf || '',
        stockTotal: fmtAED(stockNetTotal),
        updated: new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Dubai' })
      };
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).send(field && Object.prototype.hasOwnProperty.call(fields, field) ? String(fields[field]) : all);
    }

    // ── rendered widget page ──────────────────────────────────────────────
    // A widget app that displays a web page needs no formulas and no preset
    // format: this IS the widget, styled here and verifiable end to end.
    if ((req.query && req.query.format) === 'html') {
      const esc = t => String(t).replace(/&/g,'&amp;').replace(/</g,'&lt;');
      const stockRows = rows.map(r => {
        const up = r.dayPct === null ? null : r.dayPct >= 0;
        const col = up === null ? '#8888a0' : (up ? '#3ecf8e' : '#f26b6b');
        return '<div class="s">'
          + '<span class="tk">' + esc(r.ticker) + '</span>'
          + '<span class="px">' + Number(r.price).toFixed(2) + '</span>'
          + '<span class="dy" style="color:' + col + '">' + esc(r.dayf) + '</span>'
          + '<span class="nt">' + esc(r.netf) + '</span>'
          + '</div>';
      }).join('');
      const overdueBlock = o.overdue.count
        ? '<div class="ov">⚠ ' + o.overdue.count + ' overdue · ' + fmtAED(o.overdue.value) + '</div>'
        : '';
      const nextDays = next ? (next.days === 0 ? 'TODAY' : 'in ' + next.days + ' day' + (next.days === 1 ? '' : 's')) : '';
      const html = '<!doctype html><meta charset="utf-8">'
        + '<meta name="viewport" content="width=device-width,initial-scale=1">'
        + '<meta http-equiv="refresh" content="300">'
        + '<title>PayTrack</title><style>'
        + '*{margin:0;padding:0;box-sizing:border-box}'
        + 'html,body{background:transparent;height:100%;overflow:hidden}'
        + 'body{font-family:Roboto,system-ui,sans-serif;-webkit-font-smoothing:antialiased}'
        + '.w{background:#0d0d12;border-radius:24px;padding:16px 18px;color:#eee;height:100%}'
        + '.hd{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px}'
        + '.bd{font-size:11px;font-weight:700;letter-spacing:.8px;color:#8888a0;text-transform:uppercase}'
        + '.up{font-size:10px;color:#44445a}'
        + '.nx{font-size:13px;color:#8888a0}'
        + '.nx b{color:#5b9cf6}'
        + '.am{font-family:"Roboto Mono",monospace;font-size:25px;font-weight:700;letter-spacing:-.5px;margin:2px 0 4px}'
        + '.ov{font-size:11px;color:#f26b6b;font-weight:600;margin-bottom:6px}'
        + '.hr{height:1px;background:rgba(255,255,255,.08);margin:10px 0}'
        + '.s{display:flex;align-items:baseline;font-family:"Roboto Mono",monospace;font-size:12px;padding:3px 0}'
        + '.tk{flex:1;color:#eee;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}'
        + '.px{width:52px;text-align:right;color:#c9c9d6}'
        + '.dy{width:62px;text-align:right}'
        + '.nt{width:96px;text-align:right;font-weight:600}'
        + '.tt{display:flex;justify-content:space-between;font-family:"Roboto Mono",monospace;'
        + 'font-size:13px;font-weight:700;margin-top:8px;padding-top:8px;border-top:1px solid rgba(255,255,255,.08)}'
        + '.tt span:first-child{font-family:Roboto,sans-serif;font-size:10px;color:#8888a0;'
        + 'text-transform:uppercase;letter-spacing:.6px;align-self:center}'
        + '</style><div class="w">'
        + '<div class="hd"><span class="bd">PayTrack</span><span class="up">'
        + new Date().toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',timeZone:'Asia/Dubai'})
        + '</span></div>'
        + (next
            ? '<div class="nx">Next · ' + esc(next.account) + ' · <b>' + nextDays + '</b></div>'
              + '<div class="am">' + fmtAED(next.amount) + '</div>'
            : '<div class="nx">Nothing scheduled</div>')
        + overdueBlock
        + '<div class="hr"></div>'
        + stockRows
        + '<div class="tt"><span>Net of margin</span><span>' + fmtAED(stockNetTotal) + '</span></div>'
        + '</div>';
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.status(200).send(html);
    }

    return res.status(200).json({
      all, compact,
      updated: new Date().toISOString(),
      updatedf: new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Dubai' }),
      stocks: rows,
      stock1: rows[0] || null, stock2: rows[1] || null, stock3: rows[2] || null,
      stockNet: stockNetTotal, stockNetf: fmtAED(stockNetTotal),
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
