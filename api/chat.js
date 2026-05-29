export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const body = req.body;
    const messages = body.messages || [];
    const system = body.system || '';
    const key = process.env.GEMINI_API_KEY;
    if (!key) return res.status(500).json({ error: 'GEMINI_API_KEY not set' });
    const contents = [
      { role: 'user', parts: [{ text: system || 'You are a helpful assistant.' }] },
      { role: 'model', parts: [{ text: 'Understood.' }] },
      ...messages.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }))
    ];
    const geminiRes = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=' + key,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contents }) }
    );
    const raw = await geminiRes.text();
    let data;
    try { data = JSON.parse(raw); } catch(e) { return res.status(500).json({ error: 'Bad JSON from Gemini', raw }); }
    if (!geminiRes.ok) return res.status(200).json({ content: [{ type: 'text', text: 'Gemini error: ' + (data.error?.message || raw) }] });
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || 'No response from Gemini.';
    return res.status(200).json({ content: [{ type: 'text', text }] });
  } catch (e) {
    return res.status(200).json({ content: [{ type: 'text', text: 'Server error: ' + e.message }] });
  }
}
