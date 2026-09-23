// Live UAE quote for one ticker. The lookup itself lives in _quotes.js so the
// widget feed prices holdings exactly the way the app does.
import { fetchQuote } from './_quotes.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');

  const ticker = String((req.query && req.query.ticker) || '');
  try {
    const q = await fetchQuote(ticker);
    if (q.error === 'Bad ticker') return res.status(400).json(q);
    return res.status(200).json(q);
  } catch (e) {
    return res.status(200).json({ error: e.message });
  }
}
