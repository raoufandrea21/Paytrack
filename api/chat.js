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
    const { messages, system, accs, stocks } = await req.json();
    const today = new Date();
    const fmt = n => 'AED ' + Math.round(n).toLocaleString();

    // Build live financial context from PayTrack data
    let financialContext = '';
    if (accs && accs.length > 0) {
      let totalOutstanding = 0, totalPaid = 0, overdueTotal = 0;
      const overdueItems = [], upcomingItems = [];
      accs.forEach(a => {
        if (!a.pays) return;
        a.pays.forEach(p => {
          if (p.status === 'paid') { totalPaid += p.amount; return; }
          totalOutstanding += p.amount;
          if (p.status === 'overdue') {
            overdueTotal += p.amount;
            overdueItems.push(a.name + ': ' + p.desc + ' - ' + fmt(p.amount) + ' (due ' + (p.nd || p.dt) + ')');
          } else {
            var parts = (p.nd || p.dt).split('-');
            var d = parts.length === 3 && parts[2].length === 4
              ? new Date(+parts[2], +parts[1]-1, +parts[0])
              : new Date(p.nd || p.dt);
            var days = Math.ceil((d - today) / 86400000);
            if (days >= 0 && days <= 90) upcomingItems.push(a.name + ': ' + p.desc + ' - ' + fmt(p.amount) + ' (due ' + (p.nd||p.dt) + ', in ' + days + ' days)');
          }
        });
      });
      const sv = stocks ? stocks.reduce((s,x) => s + x.qty*(x.cp||0), 0) : 0;
      const sgl = stocks ? stocks.reduce((s,x) => s + x.qty*((x.cp||0)-(x.bp||0)), 0) : 0;
      const nb = sv - totalOutstanding;
      financialContext = `
=== PAYTRACK LIVE DATA (${today.toLocaleDateString('en-GB')}) ===
SUMMARY:
- Total Outstanding: ${fmt(totalOutstanding)}
- Total Paid (all time): ${fmt(totalPaid)}
- Overdue Amount: ${fmt(overdueTotal)}
- Stock Portfolio: ${fmt(sv)} (G/L: ${sgl>=0?'+':''}${fmt(sgl)})
- Net Balance (Stocks - Outstanding): ${fmt(nb)}

ACCOUNTS:
${accs.map(a => {
  const paid = (a.pays||[]).filter(p=>p.status==='paid').reduce((s,p)=>s+p.amount,0);
  const out = (a.pays||[]).filter(p=>p.status!=='paid').reduce((s,p)=>s+p.amount,0);
  const ov = (a.pays||[]).filter(p=>p.status==='overdue').reduce((s,p)=>s+p.amount,0);
  const total = paid+out;
  const pct = total>0?Math.round(paid/total*100):0;
  return '- ' + a.name + ' (' + a.type + '): Total ' + fmt(total) + ' | Paid ' + fmt(paid) + ' (' + pct + '%) | Outstanding ' + fmt(out) + (ov>0?' | OVERDUE '+fmt(ov):'');
}).join('\n')}

${overdueItems.length>0 ? 'OVERDUE ('+overdueItems.length+'):\n'+overdueItems.slice(0,10).map(i=>'- '+i).join('\n') : 'NO OVERDUE PAYMENTS'}

${upcomingItems.length>0 ? 'UPCOMING 90 DAYS ('+upcomingItems.length+'):\n'+upcomingItems.slice(0,10).map(i=>'- '+i).join('\n') : 'NO UPCOMING IN 90 DAYS'}

${stocks&&stocks.length>0 ? 'STOCKS:\n'+stocks.map(s=>'- '+s.ticker+' ('+s.mkt+'): Qty '+s.qty.toLocaleString()+' | Buy '+s.cur+' '+(s.bp||0).toFixed(2)+' | Current '+s.cur+' '+(s.cp||0).toFixed(2)+' | G/L: '+fmt(s.qty*((s.cp||0)-(s.bp||0)))).join('\n') : 'NO STOCKS'}
=== END PAYTRACK DATA ===`;
    }

    const systemPrompt = `You are PayTrack AI - a sharp financial assistant for Raouf Andrea. You have live access to his financial data and can search the web for current market info.

${financialContext}

INSTRUCTIONS:
- Always use the live PayTrack numbers above when answering financial questions
- Be direct, specific, use actual figures from the data
- For market questions (stocks, UAE property, interest rates, news), use web search
- Answer in the same language the user writes (Arabic or English)
- Today: ${today.toLocaleDateString('en-GB', {weekday:'long',day:'numeric',month:'long',year:'numeric'})}`;

    const history = messages.map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }]
    }));

    const contents = [
      { role: 'user', parts: [{ text: systemPrompt }] },
      { role: 'model', parts: [{ text: 'Ready. I have your live PayTrack data and web search access.' }] },
      ...history
    ];

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents,
          tools: [{ google_search: {} }],
          generationConfig: { maxOutputTokens: 2048, temperature: 0.7 }
        })
      }
    );

    const data = await response.json();
    if (!response.ok) return new Response(JSON.stringify({ error: data.error?.message || 'Gemini error' }), { status: response.status, headers });

    const candidate = data.candidates?.[0];
    let text = (candidate?.content?.parts || []).filter(p=>p.text).map(p=>p.text).join('') || 'No response.';

    const queries = candidate?.groundingMetadata?.webSearchQueries;
    if (queries?.length) text += '\n\n*Searched: ' + queries.join(', ') + '*';

    return new Response(JSON.stringify({ content: [{ type: 'text', text }] }), { status: 200, headers });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers });
  }
}
