export const config = { runtime: 'edge' };

export default async function handler(req) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };
  if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers });
  if (req.method !== 'POST') return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers });
  try {
    const { messages, system } = await req.json();
    const history = messages.map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }]
    }));
    const contents = system
      ? [
          { role: 'user', parts: [{ text: system }] },
          { role: 'model', parts: [{ text: 'Understood. Ready to help.' }] },
          ...history
        ]
      : history;
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-lite:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents, generationConfig: { maxOutputTokens: 1024, temperature: 0.7 } })
      }
    );
    const data = await response.json();
    if (!response.ok) return new Response(JSON.stringify({ error: data.error?.message || 'Gemini error' }), { status: response.status, headers });
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || 'No response.';
    return new Response(JSON.stringify({ content: [{ type: 'text', text }] }), { status: 200, headers });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers });
  }
}
