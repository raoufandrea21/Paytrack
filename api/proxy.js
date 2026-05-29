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
  try {
    const response = await fetch(decodeURIComponent(url));
    const text = await response.text();
    return new Response(text, { status: 200, headers });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers });
  }
}
