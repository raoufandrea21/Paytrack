// The widget summary, in ONE place.
//
// Both the browser (writing paytrack.json to a local folder) and /api/widget
// build the feed from this module, so the two can never drift apart. It is a
// pure function: give it the stored records, get the summary back. No globals,
// no DOM, no network -- which is also why it runs unchanged on the server.
//
// The rules mirror the app exactly:
//   owed      not paid and not deferred (a deferred instalment is carried to
//             the end of the term by a replacement row, so counting it here
//             would double it)
//   net       stocks minus margin, matching the Total net worth card. Savings
//             stay as their own field and never feed net.
//   margin    owed to a brokerage account, so it is split across that broker's
//             holdings in proportion to value ("Net at <broker>").

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
                'August', 'September', 'October', 'November', 'December'];

// Same formats as the app's pd(): DD-MM-YYYY, YYYY-MM-DD, DD.MM.YYYY, DD-Mon-YY(YY).
const MON = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
export function parseDate(v) {
  if (!v) return null;
  if (v instanceof Date) return v;
  const s = String(v).trim();
  let m = s.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (m) return new Date(+m[3], +m[2] - 1, +m[1]);
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
  m = s.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (m) return new Date(+m[3], +m[2] - 1, +m[1]);
  m = s.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})$/);
  if (m && m[2] in MON) return new Date(m[3].length === 2 ? 2000 + +m[3] : +m[3], MON[m[2]], +m[1]);
  return null;
}

const effDate = p => ((p.nd && String(p.nd).trim()) ? p.nd : p.dt);
const isOwed = p => !!p && p.status !== 'paid' && p.status !== 'deferred';
const num = n => (isFinite(+n) ? Math.round(+n * 100) / 100 : 0);

function isoDay(d) {
  if (!d) return '';
  const m = d.getMonth() + 1, day = d.getDate();
  return d.getFullYear() + '-' + (m < 10 ? '0' : '') + m + '-' + (day < 10 ? '0' : '') + day;
}

function label(s) {
  if (s === 'notpaid') return 'not paid';
  if (s === 'confirm') return 'confirm cheque';
  return s || 'not paid';
}

export function buildWidgetSummary(data, now = new Date()) {
  const accs = Array.isArray(data && data.accs) ? data.accs : [];
  const stocks = Array.isArray(data && data.stocks) ? data.stocks : [];
  const savings = Array.isArray(data && data.savings) ? data.savings : [];
  const margins = (data && data.margins && typeof data.margins === 'object') ? data.margins : {};
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  // every payment once, with the date the app would act on
  const rows = [];
  accs.forEach(a => (a.pays || []).forEach(p => {
    rows.push({
      acc: a.name, desc: p.desc || 'Payment',
      amount: +p.amount || 0, status: p.status || 'notpaid',
      d: parseDate(effDate(p)), owed: isOwed(p)
    });
  }));

  const dated = rows.filter(r => r.owed && r.d).sort((x, y) => x.d - y.d);
  const ahead = dated.filter(r => r.d >= today);

  const n = ahead[0] || null;
  const next = n ? {
    date: isoDay(n.d), account: n.acc, desc: n.desc, amount: num(n.amount),
    daysAway: Math.round((n.d - today) / 86400000)
  } : { date: '', account: '', desc: '', amount: 0, daysAway: 0 };

  const monthBlock = offset => {
    const t = new Date(today.getFullYear(), today.getMonth() + offset, 1);
    const sel = dated.filter(r => r.d.getFullYear() === t.getFullYear() && r.d.getMonth() === t.getMonth());
    return {
      label: MONTHS[t.getMonth()] + ' ' + t.getFullYear(),
      amount: num(sel.reduce((s, r) => s + r.amount, 0)),
      count: sel.length
    };
  };

  // Overdue: owed and the date has passed, plus rows already flagged overdue.
  // Deferred is never overdue -- it was pushed back on purpose.
  const over = rows.filter(r => r.owed && (r.status === 'overdue' || (!!r.d && r.d < today)));
  const defer = rows.filter(r => r.status === 'deferred');

  const upcoming = ahead.slice(0, 6).map(r => ({
    date: isoDay(r.d), account: r.acc, desc: r.desc,
    amount: num(r.amount), status: label(r.status)
  }));

  // ── stocks ──
  const priceOf = s => +(s.livePrice || s.cp || 0);
  const brokerValue = {};
  stocks.forEach(s => {
    const b = String(s.broker || '').trim();
    brokerValue[b] = (brokerValue[b] || 0) + (+s.qty || 0) * priceOf(s);
  });

  let pricesAt = 0;
  const holdings = stocks.map(s => {
    const price = priceOf(s);
    // Without a stored previous close, treat today's move as zero rather than
    // inventing one against the buy price.
    const prev = +(s.prevClose || price);
    const qty = +s.qty || 0;
    const value = qty * price;
    const bp = +s.bp || 0;
    if (s.liveAt && s.liveAt > pricesAt) pricesAt = s.liveAt;
    const brk = String(s.broker || '').trim();
    const bv = brokerValue[brk] || 0;
    const brokerMargin = (brk && margins[brk]) ? +margins[brk] : 0;
    const share = (brokerMargin && bv > 0) ? (brokerMargin * (value / bv)) : 0;
    return {
      ticker: s.ticker || '', name: s.name || s.ticker || '',
      broker: brk, qty, price: num(price), prevClose: num(prev),
      value: num(value), netValue: num(value - share),
      dayChange: num(qty * (price - prev)),
      dayChangePct: num(prev > 0 ? ((price - prev) / prev * 100) : 0),
      totalPnl: num(qty * (price - bp)),
      totalPnlPct: num(bp > 0 ? ((price - bp) / bp * 100) : 0),
      currency: s.cur || 'AED'
    };
  });

  const marketValue = holdings.reduce((t, h) => t + h.value, 0);
  const prevValue = holdings.reduce((t, h) => t + h.qty * h.prevClose, 0);
  const dayChange = holdings.reduce((t, h) => t + h.dayChange, 0);
  const marginOwed = Object.keys(margins)
    .filter(k => k !== '__migrated')
    .reduce((t, b) => t + (+margins[b] || 0), 0);
  const sav = savings.reduce((t, s) => t + (+s.amount || 0), 0);

  return {
    app: 'paytrack', schema: 1, generated: now.toISOString(),
    next,
    thisMonth: monthBlock(0), nextMonth: monthBlock(1),
    overdue: { amount: num(over.reduce((s, r) => s + r.amount, 0)), count: over.length },
    deferred: { amount: num(defer.reduce((s, r) => s + r.amount, 0)), count: defer.length },
    upcoming,
    stocks: {
      marketValue: num(marketValue), marginOwed: num(marginOwed),
      savings: num(sav), net: num(marketValue - marginOwed),
      dayChange: num(dayChange),
      dayChangePct: num(prevValue > 0 ? (dayChange / prevValue * 100) : 0),
      pricesAt: pricesAt ? new Date(pricesAt).toISOString() : now.toISOString(),
      holdings
    }
  };
}
