// Live UAE quotes via TradingView's public scanner.
//
// Yahoo has no ADX coverage at all, which left ADX-listed holdings frozen on a
// manually typed price. This endpoint is deliberately narrow -- it accepts a
// ticker, not a URL, and only ever calls TradingView -- unlike /api/proxy,
// which will fetch anything it is handed.

const EXCHANGES = ['ADX', 'DFM'];

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');

  const ticker = String((req.query && req.query.ticker) || '').toUpperCase().trim();
  if (!/^[A-Z0-9._-]{1,24}$/.test(ticker)) {
    return res.status(400).json({ error: 'Bad ticker' });
  }

  const tickers = EXCHANGES.map(x => `${x}:${ticker}`);
  try {
    const r = await fetch('https://scanner.tradingview.com/uae/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        symbols: { tickers, query: { types: [] } },
        columns: ['close', 'change', 'currency', 'description']
      })
    });
    if (!r.ok) return res.status(200).json({ error: 'upstream ' + r.status });

    const j = await r.json();
    const row = (j.data || []).find(d => d.d && typeof d.d[0] === 'number' && d.d[0] > 0);
    if (!row) return res.status(200).json({ error: 'not found', tried: tickers });

    const [close, changePct, currency, name] = row.d;
    // TradingView gives the day's % change; derive the previous close from it
    const prev = typeof changePct === 'number' && changePct !== -100
      ? close / (1 + changePct / 100)
      : null;

    return res.status(200).json({
      price: close,
      prev: prev,
      changePct: changePct,
      currency: currency || 'AED',
      name: name || ticker,
      symbol: row.s,
      source: 'tradingview'
    });
  } catch (e) {
    return res.status(200).json({ error: e.message });
  }
}
