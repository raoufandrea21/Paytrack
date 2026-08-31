// ── CFO context engine ────────────────────────────────────────────────────
// Every financial number the AI CFO reports is computed HERE, deterministically,
// from the stored PayTrack records. The model is given these figures to
// interpret and prioritise -- it never adds up payments itself, and it never
// sees the raw record set. That keeps the arithmetic auditable and identical to
// what the app shows on screen.
//
// The rules mirror index.html exactly:
//   owed(p)      not paid and not deferred (a deferred instalment is carried to
//                the end of the term by a replacement row, so counting it here
//                would double it)
//   unsched(a)   principal with no payment rows behind it, e.g. an open-ended
//                loan from a person
//   equity       only payments already MADE on accounts that buy something kept

export function parseDate(v) {
  if (!v) return null;
  const s = String(v).trim();
  let m = s.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (m) return new Date(+m[3], +m[2] - 1, +m[1]);
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
  m = s.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (m) return new Date(+m[3], +m[2] - 1, +m[1]);
  return null;
}

export const effDate = p => ((p.nd && String(p.nd).trim()) ? p.nd : p.dt);
export const isOwed  = p => !!p && p.status !== 'paid' && p.status !== 'deferred';
const round = n => Math.round(n || 0);

function unscheduled(a) {
  const sched = (a.pays || []).reduce((t, p) => t + (p.status === 'deferred' ? 0 : (p.amount || 0)), 0);
  return Math.max(0, (a.principal || 0) - sched);
}
function purposeOf(a) {
  if (a && a.purpose) return a.purpose;
  return (a && (a.type === 'Installments' || a.type === 'Mortgage')) ? 'buy' : 'expense';
}
function equityOf(a) {
  if (purposeOf(a) !== 'buy') return 0;
  return (a.pays || []).reduce((t, p) => t + (p.status === 'paid' ? (p.amount || 0) : 0), 0);
}

// Flatten every unpaid obligation once, with the context needed to trace it back.
function obligations(accs, today) {
  const out = [];
  (accs || []).forEach(a => {
    (a.pays || []).forEach((p, i) => {
      if (!isOwed(p)) return;
      const d = parseDate(effDate(p));
      out.push({
        account: a.name, accountId: a.id, index: i,
        desc: p.desc || 'Payment', amount: p.amount || 0,
        date: effDate(p) || null,
        days: d ? Math.round((d - today) / 86400000) : null,
        status: p.status, cheque: p.chq || null,
        forecast: !!p.forecast, dated: !!d
      });
    });
  });
  return out;
}

export function buildCFOContext(data) {
  const accs    = Array.isArray(data.accs) ? data.accs : [];
  const stocks  = Array.isArray(data.stocks) ? data.stocks : [];
  const savings = Array.isArray(data.savings) ? data.savings : [];
  const margins = (data.margins && typeof data.margins === 'object') ? data.margins : {};

  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  const obs = obligations(accs, today);
  const dated = obs.filter(o => o.dated);

  const within = d => dated.filter(o => o.days >= 0 && o.days <= d);
  const sum = arr => round(arr.reduce((t, o) => t + o.amount, 0));

  const overdue = obs.filter(o => o.status === 'overdue');
  const unconfirmed = obs.filter(o => o.status === 'confirm' || o.status === 'delayed');
  const undated = obs.filter(o => !o.dated);

  // ── portfolio ──
  const portfolioValue = round(stocks.reduce((t, s) => t + (s.qty || 0) * (s.cp || 0), 0));
  const invested = round(stocks.reduce((t, s) => t + (s.qty || 0) * (s.bp || 0), 0));
  const unrealised = round(portfolioValue - invested);
  const marginTotal = round(Object.keys(margins).filter(k => k !== '__migrated')
    .reduce((t, b) => t + (+margins[b] || 0), 0));
  const savingsTotal = round(savings.reduce((t, s) => t + (+s.amount || 0), 0));

  // ── balance sheet ──
  const propertyEquity = round(accs.reduce((t, a) => t + equityOf(a), 0));
  const borrowed = round(accs.reduce((t, a) => {
    if (a.type !== 'Lender' && !a.openEnded) return t;
    return t + (a.pays || []).reduce((x, p) => x + (isOwed(p) ? (p.amount || 0) : 0), 0) + unscheduled(a);
  }, 0));
  const totalOutstanding = round(sum(obs) + accs.reduce((t, a) => t + unscheduled(a), 0));
  const netWorth = round(propertyEquity + savingsTotal + portfolioValue - marginTotal - borrowed);

  // ── month by month, 12 back and 12 forward ──
  const base = today.getFullYear() * 12 + today.getMonth();
  const monthly = {};
  (accs || []).forEach(a => (a.pays || []).forEach(p => {
    const d = parseDate(effDate(p)); if (!d) return;
    const k = d.getFullYear() * 12 + d.getMonth();
    if (k < base - 12 || k > base + 12) return;
    monthly[k] = monthly[k] || { key: k, due: 0, paid: 0, count: 0 };
    if (p.status === 'paid') monthly[k].paid += (p.amount || 0);
    else if (isOwed(p)) { monthly[k].due += (p.amount || 0); monthly[k].count++; }
  }));
  const MN = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const timeline = Object.values(monthly).sort((a, b) => a.key - b.key).map(m => ({
    month: MN[m.key % 12] + ' ' + Math.floor(m.key / 12),
    ahead: m.key - base,
    due: round(m.due), paid: round(m.paid), count: m.count
  }));

  const future = timeline.filter(m => m.ahead >= 0 && m.due > 0);
  const peak = future.slice().sort((a, b) => b.due - a.due)[0] || null;
  const past = timeline.filter(m => m.ahead < 0 && m.paid > 0);
  const avgPaid = past.length ? round(past.reduce((t, m) => t + m.paid, 0) / past.length) : 0;

  const next30 = sum(within(30)), next90 = sum(within(90));
  const next180 = sum(within(180)), next365 = sum(within(365));

  const largest = dated.filter(o => o.days >= 0 && o.days <= 90)
    .sort((a, b) => b.amount - a.amount).slice(0, 5);

  const liquid = portfolioValue + savingsTotal - marginTotal;

  // ── accounts ──
  const accounts = accs.map(a => {
    const paid = (a.pays || []).filter(p => p.status === 'paid').reduce((t, p) => t + (p.amount || 0), 0);
    const out  = (a.pays || []).filter(isOwed).reduce((t, p) => t + (p.amount || 0), 0);
    const uns  = unscheduled(a);
    return {
      id: a.id, name: a.name, type: a.type, purpose: purposeOf(a),
      openEnded: !!a.openEnded, principal: round(a.principal),
      paid: round(paid), outstanding: round(out + uns), unscheduled: round(uns),
      overdueCount: (a.pays || []).filter(p => p.status === 'overdue').length,
      payments: (a.pays || []).length
    };
  });

  // ── risks: detected in code, ranked by money at stake ──
  const risks = [];
  if (overdue.length) risks.push({
    severity: 'critical', key: 'overdue',
    title: overdue.length + ' overdue payment' + (overdue.length > 1 ? 's' : ''),
    value: sum(overdue),
    detail: overdue.map(o => o.account + ' — ' + o.desc + ' (' + o.date + ')').slice(0, 6),
    action: 'See overdue payments', link: 'dash'
  });
  if (peak && next90 > 0 && peak.ahead <= 3 && peak.due > next90 * 0.4) risks.push({
    severity: 'important', key: 'concentration',
    title: peak.month + ' carries ' + Math.round(peak.due / next90 * 100) + '% of your next 90 days',
    value: peak.due,
    detail: [peak.count + ' payments fall in ' + peak.month],
    action: 'View schedule', link: 'monthly'
  });
  // Compare the next FULL month, not the current one: the current month is
  // dominated by anything already overdue, which is reported separately.
  const nextFull = timeline.find(m => m.ahead >= 1 && m.due > 0);
  if (avgPaid > 0 && nextFull && nextFull.due > avgPaid * 1.3) risks.push({
    severity: 'important', key: 'above-average',
    title: nextFull.month + ' is ' + Math.round((nextFull.due / avgPaid - 1) * 100) + '% above your monthly average',
    value: nextFull.due,
    detail: ['Average paid over the last ' + past.length + ' active months: AED ' + avgPaid.toLocaleString()],
    action: 'View schedule', link: 'monthly'
  });
  if (unconfirmed.length) risks.push({
    severity: 'important', key: 'unconfirmed',
    title: unconfirmed.length + ' payment' + (unconfirmed.length > 1 ? 's' : '') + ' awaiting confirmation',
    value: sum(unconfirmed),
    detail: unconfirmed.map(o => o.account + ' — ' + o.desc + (o.cheque ? ' (cheque ' + o.cheque + ')' : '')).slice(0, 6),
    action: 'Review payments', link: 'accs'
  });
  if (undated.length) risks.push({
    severity: 'watch', key: 'undated',
    title: undated.length + ' unpaid item' + (undated.length > 1 ? 's have' : ' has') + ' no date',
    value: sum(undated),
    detail: undated.map(o => o.account + ' — ' + o.desc).slice(0, 6),
    action: 'Fix the dates', link: 'accs'
  });
  const unschedAccs = accounts.filter(a => a.unscheduled > 0);
  if (unschedAccs.length) risks.push({
    severity: 'watch', key: 'unscheduled',
    title: 'AED ' + round(unschedAccs.reduce((t, a) => t + a.unscheduled, 0)).toLocaleString() + ' of debt has no schedule',
    value: round(unschedAccs.reduce((t, a) => t + a.unscheduled, 0)),
    detail: unschedAccs.map(a => a.name + ' — AED ' + a.unscheduled.toLocaleString() + (a.openEnded ? ' (open-ended)' : '')),
    action: 'Open accounts', link: 'accs'
  });
  if (stocks.length) {
    const top = stocks.slice().sort((a, b) => (b.qty * (b.cp || 0)) - (a.qty * (a.cp || 0)))[0];
    const share = portfolioValue > 0 ? (top.qty * (top.cp || 0)) / portfolioValue : 0;
    if (share > 0.5) risks.push({
      severity: 'watch', key: 'stock-concentration',
      title: top.ticker + ' is ' + Math.round(share * 100) + '% of your portfolio',
      value: round(top.qty * (top.cp || 0)),
      detail: ['Portfolio value AED ' + portfolioValue.toLocaleString()],
      action: 'View portfolio', link: 'stk'
    });
  }
  if (marginTotal > 0 && portfolioValue > 0 && marginTotal / portfolioValue > 0.35) risks.push({
    severity: 'important', key: 'margin',
    title: 'Margin is ' + Math.round(marginTotal / portfolioValue * 100) + '% of portfolio value',
    value: marginTotal,
    detail: Object.keys(margins).filter(k => k !== '__migrated')
      .map(b => b + ' — AED ' + round(margins[b]).toLocaleString()),
    action: 'View portfolio', link: 'stk'
  });
  if (!overdue.length && !unconfirmed.length && next30 === 0) risks.push({
    severity: 'positive', key: 'clear',
    title: 'Nothing due in the next 30 days',
    value: 0, detail: [], action: 'View schedule', link: 'monthly'
  });

  const order = { critical: 0, important: 1, watch: 2, positive: 3 };
  risks.sort((a, b) => (order[a.severity] - order[b.severity]) || (b.value - a.value));

  // What we do NOT know. The model is told to say so rather than guess.
  const missing = [];
  if (!savings.length) missing.push('No cash or bank balances are recorded, so liquidity cover cannot be confirmed.');
  if (!stocks.length) missing.push('No investment positions are tracked.');
  if (undated.length) missing.push(undated.length + ' unpaid item(s) have no date and are excluded from every time-based figure.');
  if (!accs.some(a => a.assetValue)) missing.push('Property market values are not recorded, so equity reflects only what has been paid.');

  return {
    generatedAt: new Date().toISOString(),
    currency: 'AED',
    summary: {
      totalOutstanding, netWorth, propertyEquity, savings: savingsTotal,
      portfolioValue, unrealised, marginTotal, borrowed,
      accounts: accs.length, openObligations: obs.length
    },
    obligations: {
      next30, next90, next180, next365,
      count30: within(30).length, count90: within(90).length,
      overdue: { count: overdue.length, value: sum(overdue) },
      unconfirmed: { count: unconfirmed.length, value: sum(unconfirmed) },
      undated: { count: undated.length, value: sum(undated) },
      largest: largest.map(o => ({ account: o.account, desc: o.desc, amount: o.amount, date: o.date, days: o.days }))
    },
    liquidity: {
      liquidAssets: round(liquid),
      cover30: next30 > 0 ? +(liquid / next30).toFixed(1) : null,
      cover90: next90 > 0 ? +(liquid / next90).toFixed(1) : null,
      monthsOfCover: avgPaid > 0 ? +(liquid / avgPaid).toFixed(1) : null,
      peakMonth: peak ? { month: peak.month, due: peak.due, count: peak.count } : null,
      averageMonthlyPaid: avgPaid
    },
    portfolio: {
      value: portfolioValue, invested, unrealised,
      returnPct: invested > 0 ? +((unrealised / invested) * 100).toFixed(1) : null,
      margin: marginTotal, positions: stocks.map(s => ({
        ticker: s.ticker, market: s.mkt, qty: s.qty,
        avgBuy: s.bp, price: s.cp, broker: s.broker || null,
        value: round((s.qty || 0) * (s.cp || 0)),
        live: !!s.livePrice, priceAgeMinutes: s.liveAt ? Math.round((Date.now() - s.liveAt) / 60000) : null
      }))
    },
    accounts,
    risks,
    timeline,
    missing
  };
}

// ── controlled query layer ────────────────────────────────────────────────
// The model asks for one of these by name; it never queries storage directly.
export const CFO_TOOLS = {
  getFinancialSummary: c => c.summary,
  getUpcomingPayments: (c, days) => {
    const d = Math.max(1, Math.min(730, +days || 30));
    return { days: d, total: d <= 30 ? c.obligations.next30 : d <= 90 ? c.obligations.next90
      : d <= 180 ? c.obligations.next180 : c.obligations.next365, largest: c.obligations.largest };
  },
  getOverduePayments: c => c.obligations.overdue,
  getLargestObligations: c => c.obligations.largest,
  getMonthlyObligations: (c, months) => c.timeline.filter(m => m.ahead >= 0 && m.ahead < (+months || 12)),
  getPortfolioSummary: c => c.portfolio,
  getAccountSummary: c => c.accounts,
  getCashRequirement: (c, days) => CFO_TOOLS.getUpcomingPayments(c, days),
  getRisks: c => c.risks
};
