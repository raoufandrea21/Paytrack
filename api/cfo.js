// AI CFO endpoint.
//
//   GET  ?action=context   deterministic metrics only, no model call
//   POST  action=brief     executive briefing over those metrics
//   POST  action=chat      conversational answer over those metrics
//
// The browser never sends the dataset: it is read here from storage under the
// caller's session, so the financial records stay server-side and the request
// carries only a question.

import { guard, kvGet } from './_auth.js';
import { buildCFOContext, CFO_TOOLS } from './_cfo.js';

const SYSTEM_PROMPT = `You are PayTrack AI CFO, a private financial intelligence layer for one owner.

You are given a JSON block of figures ALREADY CALCULATED from the owner's PayTrack records. Your job is to interpret, prioritise and recommend — never to recompute.

Rules:
- Never invent a number. Every figure you state must appear in the JSON. If something is not there, say plainly that it is not tracked.
- The "missing" array lists what PayTrack does not know. Respect it. Do not infer income, cash balances or asset values that are absent.
- Currency is AED unless a position says otherwise.
- Be concise, numerical and decision-oriented. Short paragraphs or tight lists.
- Separate fact from interpretation. "AED 486,907 is overdue" is a fact; "this is your most pressing item" is your judgement — make the difference clear.
- Prioritise in this order: overdue items, liquidity risk, payment concentration, unconfirmed commitments, portfolio and margin exposure, then opportunities.
- Property equity counts only what has been PAID. Remaining instalments are future obligations, not current losses. Do not treat them as a deficit.
- No generic financial-planning talk, no motivational language, no disclaimers about consulting an advisor.
- You are briefing a CEO who reads quickly. Lead with what matters.`;

async function askGemini(prompt, history) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return { error: 'AI is not configured.' };
  const contents = [
    { role: 'user', parts: [{ text: SYSTEM_PROMPT }] },
    { role: 'model', parts: [{ text: 'Understood. I will interpret the supplied figures and never invent any.' }] },
    ...(history || []).map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: String(m.content || '').slice(0, 4000) }]
    })),
    { role: 'user', parts: [{ text: prompt }] }
  ];
  try {
    const r = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' + key,
      { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents, generationConfig: { maxOutputTokens: 1400, temperature: 0.4 } }) }
    );
    const j = await r.json();
    if (!r.ok) return { error: j.error?.message || 'AI request failed.' };
    const text = (j.candidates?.[0]?.content?.parts || []).filter(p => p.text).map(p => p.text).join('');
    return text ? { text } : { error: 'No response from the model.' };
  } catch (e) {
    return { error: e.message };
  }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!(await guard(req, res))) return;

  let ctx;
  try {
    const raw = await kvGet('paytrack_data');
    if (!raw) return res.status(200).json({ error: 'No PayTrack data is stored yet.' });
    let data = JSON.parse(raw);
    if (data && typeof data.value === 'string') data = JSON.parse(data.value);
    ctx = buildCFOContext(data);
  } catch (e) {
    return res.status(500).json({ error: 'Could not read your data: ' + e.message });
  }

  const action = (req.query && req.query.action) || (req.body && req.body.action) || 'context';

  // Deterministic only. This keeps the dashboard alive when the model is not.
  if (action === 'context') return res.status(200).json({ context: ctx });

  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  // Trim the context sent to the model: figures and risks, not every record.
  const forModel = {
    summary: ctx.summary, obligations: ctx.obligations, liquidity: ctx.liquidity,
    portfolio: { ...ctx.portfolio, positions: ctx.portfolio.positions.slice(0, 12) },
    accounts: ctx.accounts, risks: ctx.risks,
    timeline: ctx.timeline.filter(m => m.ahead >= -3 && m.ahead <= 12),
    missing: ctx.missing
  };

  if (action === 'brief') {
    const out = await askGemini(
      'Write the executive briefing for today from these figures.\n\n' +
      'Use exactly these headings, each followed by one or two short sentences:\n' +
      'Financial position\nNear-term exposure\nPrimary concern\nPortfolio\nRecommended actions\n\n' +
      'Under "Recommended actions" give 2 to 4 numbered, specific actions tied to the figures.\n' +
      'Plain text, no markdown symbols.\n\nFIGURES:\n' + JSON.stringify(forModel),
      []
    );
    return res.status(200).json({ ...out, context: ctx });
  }

  if (action === 'insights') {
    const out = await askGemini(
      'Give 3 to 5 short observations a CFO would flag from these figures. ' +
      'One sentence each, each containing a specific number or percentage drawn from the JSON. ' +
      'Return one per line, no numbering, no markdown.\n\nFIGURES:\n' + JSON.stringify(forModel),
      []
    );
    return res.status(200).json(out);
  }

  if (action === 'chat') {
    const q = String((req.body && req.body.question) || '').slice(0, 2000);
    if (!q) return res.status(400).json({ error: 'No question.' });
    const history = Array.isArray(req.body.history) ? req.body.history.slice(-8) : [];
    const out = await askGemini(
      'Answer the owner\'s question from these figures.\n' +
      'If it names a period or category, quote the exact figure and then explain briefly what it means.\n' +
      'If the figures do not contain the answer, say what is missing rather than estimating.\n\n' +
      'FIGURES:\n' + JSON.stringify(forModel) + '\n\nQUESTION: ' + q,
      history
    );
    return res.status(200).json(out);
  }

  if (action === 'tool') {
    const name = String((req.body && req.body.name) || '');
    if (!Object.prototype.hasOwnProperty.call(CFO_TOOLS, name)) {
      return res.status(400).json({ error: 'Unknown tool' });
    }
    return res.status(200).json({ result: CFO_TOOLS[name](ctx, req.body.arg) });
  }

  return res.status(400).json({ error: 'Unknown action' });
}
