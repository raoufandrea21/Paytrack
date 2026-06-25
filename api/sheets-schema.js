// =============================================================
// PayTrack - /api/sheets-schema.js
// Serverless function: fetches Google Sheets CSV (CORS proxy)
// and uses Gemini to auto-detect the column schema.
// =============================================================

const https = require('https');
const http  = require('http');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')
    return res.status(405).json({ error: 'POST only' });

  let body = '';
  req.on('data', chunk => (body += chunk));
  await new Promise(resolve => req.on('end', resolve));

  const { csvUrl } = JSON.parse(body || '{}');
  if (!csvUrl) return res.status(400).json({ error: 'csvUrl required' });

  try {
    const csvText = await fetchUrl(csvUrl);
    const rows    = parseCSV(csvText);
    if (!rows.length) throw new Error('CSV appears empty or unparseable');
    const schema = await geminiDetectSchema(rows.slice(0, 8));
    res.status(200).json({ schema, rows, totalRows: rows.length });
  } catch (err) {
    console.error('[sheets-schema]', err.message);
    res.status(500).json({ error: err.message });
  }
};

function fetchUrl(url, redirectCount = 0) {
  if (redirectCount > 5) throw new Error('Too many redirects');
  return new Promise((resolve, reject) => {
    const lib     = url.startsWith('https://') ? https : http;
    const options = { headers: { 'User-Agent': 'Mozilla/5.0 PayTrack/1.0' } };
    lib.get(url, options, resp => {
      if (resp.statusCode >= 300 && resp.statusCode < 400 && resp.headers.location) {
        return fetchUrl(resp.headers.location, redirectCount + 1).then(resolve).catch(reject);
      }
      let data = '';
      resp.on('data', chunk => (data += chunk));
      resp.on('end',  ()    => resolve(data));
      resp.on('error', reject);
    }).on('error', reject);
  });
}

function parseCSV(text) {
  return text.split('\n').map(line => {
    const cols = [];
    let cur = '', inQ = false;
    for (const ch of line) {
      if (ch === '"') { inQ = !inQ; continue; }
      if (ch === ',' && !inQ) { cols.push(cur.trim()); cur = ''; }
      else cur += ch;
    }
    cols.push(cur.trim());
    return cols;
  }).filter(row => row.some(c => c.trim()));
}

async function geminiDetectSchema(sampleRows) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY env var not set');

  const prompt = `You are analyzing a Google Sheets payment schedule CSV from a real estate developer.

Here are the first rows (JSON array of string arrays, 0-indexed):
${JSON.stringify(sampleRows, null, 2)}

Identify 0-based column indices. Rules:
- dateCols: ALL columns with dates (DD-MM-YYYY), developers add new date columns over time
- effectiveDateCol: RIGHTMOST date column with any non-empty, non-"-" value
- paidStatusCol: column containing "PAID" text (not "Open"). Use -1 if none.
- headerRows: number of title/header rows before data rows begin
- Use -1 for absent columns

Respond ONLY with raw JSON (no markdown):
{
  "paymentIdCol": <int>,
  "descriptionCol": <int>,
  "amountCol": <int>,
  "percentCol": <int or -1>,
  "chequeCol": <int or -1>,
  "dateCols": [<int>, ...],
  "effectiveDateCol": <int>,
  "paidStatusCol": <int or -1>,
  "headerRows": <int>
}`;

  const body = JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0, maxOutputTokens: 512 }
  });

  const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${key}`;
  const responseText = await httpsPost(geminiUrl, body);
  const data = JSON.parse(responseText);
  const raw  = data.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
  const clean = raw.replace(/```json\n?|```/g, '').trim();

  try {
    return JSON.parse(clean);
  } catch {
    console.warn('[sheets-schema] Using fallback schema');
    return {
      paymentIdCol: 0, descriptionCol: 1, amountCol: 4, percentCol: 3,
      chequeCol: 5, dateCols: [6, 7, 8], effectiveDateCol: 8,
      paidStatusCol: 9, headerRows: 3
    };
  }
}

function httpsPost(url, bodyString) {
  return new Promise((resolve, reject) => {
    const { hostname, pathname, search } = new URL(url);
    const req = https.request({
      hostname, path: pathname + search, method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyString)
      }
    }, resp => {
      let data = '';
      resp.on('data', chunk => (data += chunk));
      resp.on('end', () => resolve(data));
      resp.on('error', reject);
    });
    req.on('error', reject);
    req.write(bodyString);
    req.end();
  });
}
