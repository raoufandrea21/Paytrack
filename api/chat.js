export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const { messages, system } = req.body;
    const history = messages.map(function(m) {
      return { role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] };
    });
    const contents = system
      ? [{ role: 'user', parts: [{ text: system }] }, { role: 'model', parts: [{ text: 'Understood. I have your financial data and am ready to help.' }] }].concat(history)
      : history;
    const response = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=' + process.env.GEMINI_API_KEY,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: contents,
          generationConfig: { maxOutputTokens: 1024, temperature: 0.7 }
        })
      }
    );
    const data = await response.json();
    if (!response.ok) return res.status(response.status).json({ error: data.error?.message || 'Gemini error' });
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || 'No response.';
    res.status(200).json({ content: [{ type: 'text', text: text }] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
