export const config = { runtime: 'edge' };

export default async function handler(req) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'text/plain; charset=utf-8'
  };
  if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers });
  const { searchParams } = new URL(req.url);
  const url = searchParams.get('url');
  if (!url) return new Response('No URL', { status: 400 });
  // Only the market-data hosts the price ticker actually needs. Without this
  // the endpoint fetches any URL it is handed, which lets anyone use the
  // deployment as an open relay and reach hosts on its behalf.
  const ALLOW = [
    'query1.finance.yahoo.com', 'query2.finance.yahoo.com',
    'scanner.tradingview.com', 'www.google.com'
  ];
  let target;
  try { target = new URL(decodeURIComponent(url)); }
  catch (e) { return new Response('Bad URL', { status: 400, headers }); }
  if (target.protocol !== 'https:' || !ALLOW.includes(target.hostname)) {
    return new Response('Host not allowed', { status: 403, headers });
  }

  try {
    const response = await fetch(target.toString());
    const text = await response.text();
    return new Response(text, { status: 200, headers });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers });
  }
}
