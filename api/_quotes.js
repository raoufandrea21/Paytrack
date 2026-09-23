// Live UAE quotes from TradingView's public scanner, shared by the /api/quote
// endpoint (the app) and the widget feed (the server). Deliberately narrow: it
// takes a ticker, never a URL, and only ever calls TradingView.
//
// ADX is tried first and DFM second, because a ticker the user files under
// "ADX" may actually be listed in Dubai -- ETIHADENERGY is, and hard-coding
// the exchange is what left it without a price.

const EXCHANGES = ['ADX', 'DFM'];

export async function fetchQuote(ticker) {
  const t = String(ticker || '').toUpperCase().trim();
  if (!/^[A-Z0-9._-]{1,24}$/.test(t)) return { error: 'Bad ticker' };

  const tickers = EXCHANGES.map(x => `${x}:${t}`);
  const r = await fetch('https://scanner.tradingview.com/uae/scan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      symbols: { tickers, query: { types: [] } },
      columns: ['close', 'change', 'currency', 'description']
    })
  });
  if (!r.ok) return { error: 'upstream ' + r.status };

  const j = await r.json();
  const row = (j.data || []).find(d => d.d && typeof d.d[0] === 'number' && d.d[0] > 0);
  if (!row) return { error: 'not found', tried: tickers };

  const [close, changePct, currency, name] = row.d;
  // TradingView gives the day's % change; derive the previous close from it.
  const prev = (typeof changePct === 'number' && changePct !== -100)
    ? close / (1 + changePct / 100)
    : null;

  return {
    price: close, prev, changePct,
    currency: currency || 'AED',
    name: name || t,
    symbol: row.s,
    source: 'tradingview'
  };
}

// Refresh a stored stocks array in place, keeping the last known price when a
// quote fails. Returns the number of holdings that actually moved.
export async function refreshStockPrices(stocks) {
  if (!Array.isArray(stocks) || !stocks.length) return 0;
  const now = Date.now();
  const results = await Promise.all(stocks.map(async s => {
    try {
      const q = await fetchQuote(s.yfSym || s.ticker);
      if (!q || !(q.price > 0)) return false;
      const moved = q.price !== s.cp;
      s.cp = q.price;
      s.livePrice = q.price;
      s.liveAt = now;
      if (q.prev > 0) s.prevClose = q.prev;
      if (q.currency) s.cur = s.cur || q.currency;
      return moved;
    } catch (e) { return false; }
  }));
  return results.filter(Boolean).length;
}
