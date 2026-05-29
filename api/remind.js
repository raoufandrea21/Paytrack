export const config = { maxDuration: 30 };

function fmt(n) { return 'AED ' + Math.round(n).toLocaleString(); }

function parseDate(s) {
  if (!s) return null;
  s = s.trim();
  let m;
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/); if (m) return new Date(+m[1],+m[2]-1,+m[3]);
  m = s.match(/^(\d{2})-(\d{2})-(\d{4})$/); if (m) return new Date(+m[3],+m[2]-1,+m[1]);
  m = s.match(/^(\d{2})\.(\d{2})\.(\d{4})$/); if (m) return new Date(+m[3],+m[2]-1,+m[1]);
  return null;
}

function effDate(p) { return (p.nd && p.nd.trim()) ? p.nd : p.dt; }

async function getAccounts() {
  const kv = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!kv || !token) return null;
  try {
    const r = await fetch(`${kv}/get/paytrack_data`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!r.ok) return null;
    const json = await r.json();
    if (!json.result) return null;
    const data = JSON.parse(json.result);
    return data.accs || null;
  } catch (e) { return null; }
}

function getFallbackAccounts() {
  const T = new Date();
  const fd = d => d.getFullYear()+'-'+(d.getMonth()+1).toString().padStart(2,'0')+'-'+d.getDate().toString().padStart(2,'0');
  return [
    {id:'nawayef',name:'Nawayef Villa',pays:[
      {desc:'ADM fees',status:'paid',amount:117679,dt:'2025-06-15',nd:'',chq:'000041'},
      {desc:'Down payment',status:'paid',amount:585900,dt:'2025-06-15',nd:'',chq:'000042'},
      {desc:'Commencement of enabling works',status:'paid',amount:292950,dt:'2025-11-30',nd:'',chq:'000043'},
      {desc:'Commencement of construction',status:'notpaid',amount:292950,dt:'2026-05-30',nd:'2026-08-30',chq:'000044'},
      {desc:'Commencement of townhouses construction',status:'notpaid',amount:585900,dt:'2026-12-30',nd:'',chq:'000045'},
      {desc:'Superstructure 100% completion',status:'notpaid',amount:292950,dt:'2027-06-30',nd:'2027-09-30',chq:'000047'},
      {desc:'Facade substantial completion',status:'notpaid',amount:292950,dt:'2027-12-30',nd:'2028-03-30',chq:'000048'},
      {desc:'Completion/BCC',status:'notpaid',amount:585900,dt:'2028-09-30',nd:'2028-12-30',chq:'000049'},
      {desc:'Handover',status:'notpaid',amount:2929500,dt:'2029-01-31',nd:'2029-04-30',chq:''}
    ]},
    {id:'mayar',name:'Mayar M13-03',pays:[
      {desc:'On booking',status:'paid',amount:77583,dt:'2024-10-31',nd:'',chq:''},
      {desc:'Down payment',status:'paid',amount:387913,dt:'2024-10-31',nd:'',chq:''},
      {desc:'Commencement of construction',status:'paid',amount:387913,dt:'2025-04-30',nd:'',chq:''},
      {desc:'50% foundation works',status:'overdue',amount:193957,dt:'2025-12-30',nd:'',chq:''},
      {desc:'50% super structure',status:'notpaid',amount:193957,dt:'2026-06-30',nd:'',chq:''},
      {desc:'100% super structure',status:'notpaid',amount:193957,dt:'2026-12-30',nd:'',chq:''},
      {desc:'Completion of super structure',status:'notpaid',amount:193957,dt:'2027-06-30',nd:'',chq:''},
      {desc:'At completion BCC',status:'notpaid',amount:2327479,dt:'2027-12-30',nd:'',chq:''}
    ]},
    {id:'sea',name:'Sea la vie',pays:[
      {desc:'During construction',status:'overdue',amount:318144,dt:'2024-12-01',nd:'',chq:''},
      {desc:'During construction',status:'overdue',amount:318144,dt:'2025-05-01',nd:'',chq:''},
      {desc:'During construction',status:'overdue',amount:318144,dt:'2025-10-01',nd:'',chq:''},
      {desc:'During construction',status:'overdue',amount:318144,dt:'2026-01-01',nd:'',chq:''},
      {desc:'On handover',status:'overdue',amount:4454010,dt:'2026-03-30',nd:'',chq:''}
    ]},
    {id:'bmw',name:'BMW X4',pays:(()=>{const r=[];for(let i=0;i<61;i++){const d=new Date('2023-08-20');d.setMonth(d.getMonth()+i);r.push({desc:'Monthly car payment',status:d>T?'notpaid':'paid',amount:5765,dt:fd(d),nd:'',chq:''});}return r;})()},
    {id:'nbf',name:'Cash Loan NBF',pays:(()=>{const r=[];for(let i=0;i<48;i++){const d=new Date('2024-12-10');d.setMonth(d.getMonth()+i);r.push({desc:'Monthly loan payment',status:d>T?'notpaid':'paid',amount:23081,dt:fd(d),nd:'',chq:''});}return r;})()},
    {id:'school',name:'School Fees',pays:[
      {desc:'Term 1',status:'paid',amount:23200,dt:'2025-08-01',nd:'',chq:''},
      {desc:'Term 2',status:'overdue',amount:19500,dt:'2025-12-12',nd:'',chq:''},
      {desc:'Term 3',status:'overdue',amount:19500,dt:'2026-03-17',nd:'',chq:''}
    ]},
    {id:'noya',name:'Noya Villa',pays:[
      {desc:'Commission to broker',status:'overdue',amount:12075,dt:'2025-09-05',nd:'',chq:''},
      {desc:'1st payment',status:'overdue',amount:57000,dt:'2025-09-05',nd:'',chq:''},
      {desc:'2nd payment',status:'overdue',amount:57000,dt:'2025-12-05',nd:'',chq:''},
      {desc:'3rd payment',status:'overdue',amount:57000,dt:'2026-03-05',nd:'',chq:''},
      {desc:'4th payment',status:'notpaid',amount:57000,dt:'2026-06-05',nd:'',chq:''}
    ]},
    {id:'ali',name:'Ali Al Gebely',pays:[]}
  ];
}

export default async function handler(req, res) {
  const authHeader = req.headers['authorization'];
  const secret = process.env.CRON_SECRET || 'paytrack2026';
  const isTest = req.method === 'GET' && req.query && req.query.test === '1';

  if (!isTest && authHeader !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const today = new Date();
  const reminderDays = parseInt(process.env.REMINDER_DAYS || '7');
  const email = process.env.REMINDER_EMAIL || 'mr.raouf@gmail.com';

  // Try to get live data from KV, fallback to hardcoded
  let accounts = await getAccounts();
  const source = accounts ? 'live (KV)' : 'fallback (hardcoded)';
  if (!accounts) accounts = getFallbackAccounts();

  const overdue = [];
  const upcoming = [];

  accounts.forEach(acc => {
    if (!acc.pays) return;
    acc.pays.forEach(p => {
      if (p.status === 'paid') return;
      const d = parseDate(effDate(p));
      if (!d) return;
      const diffDays = Math.ceil((d - today) / (1000 * 60 * 60 * 24));
      if (diffDays < 0) {
        overdue.push({ acc: acc.name, desc: p.desc, amount: p.amount, date: effDate(p), chq: p.chq || '', daysAgo: Math.abs(diffDays) });
      } else if (diffDays <= reminderDays) {
        upcoming.push({ acc: acc.name, desc: p.desc, amount: p.amount, date: effDate(p), chq: p.chq || '', daysLeft: diffDays });
      }
    });
  });

  if (overdue.length === 0 && upcoming.length === 0) {
    return res.status(200).json({ message: 'No reminders today.', source });
  }

  const dateStr = today.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  let body = `Hi Raouf,\n\nPayTrack daily reminder — ${dateStr}\nData source: ${source}\n\n`;

  if (overdue.length > 0) {
    const total = overdue.reduce((s, p) => s + p.amount, 0);
    body += `⚠️ OVERDUE (${overdue.length} payments)\n${'─'.repeat(48)}\n`;
    overdue.slice(0, 20).forEach(p => {
      body += `• ${p.acc} — ${p.desc}\n  ${fmt(p.amount)}  |  Was due: ${p.date} (${p.daysAgo} days ago)${p.chq ? '  |  Chq: ' + p.chq : ''}\n\n`;
    });
    body += `Total overdue: ${fmt(total)}\n\n`;
  }

  if (upcoming.length > 0) {
    const total = upcoming.reduce((s, p) => s + p.amount, 0);
    upcoming.sort((a, b) => a.daysLeft - b.daysLeft);
    body += `📅 DUE IN NEXT ${reminderDays} DAYS (${upcoming.length} payments)\n${'─'.repeat(48)}\n`;
    upcoming.forEach(p => {
      body += `• ${p.acc} — ${p.desc}\n  ${fmt(p.amount)}  |  ${p.daysLeft === 0 ? 'DUE TODAY' : 'Due in ' + p.daysLeft + ' days'}: ${p.date}${p.chq ? '  |  Chq: ' + p.chq : ''}\n\n`;
    });
    body += `Total: ${fmt(total)}\n\n`;
  }

  body += `${'─'.repeat(48)}\nView dashboard: https://paytrack-ashy.vercel.app\nGenerated by PayTrack.`;

  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) {
    return res.status(200).json({ message: 'Set RESEND_API_KEY to enable emails.', source, overdue: overdue.length, upcoming: upcoming.length, preview: body.substring(0, 500) });
  }

  const emailRes = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${resendKey}` },
    body: JSON.stringify({
      from: 'PayTrack <onboarding@resend.dev>',
      to: [email],
      subject: `PayTrack${overdue.length > 0 ? ' ⚠️ ' + overdue.length + ' overdue ·' : ''} ${upcoming.length} due soon — ${today.toLocaleDateString('en-GB')}`,
      text: body
    })
  });

  const emailData = await emailRes.json();
  if (!emailRes.ok) return res.status(500).json({ error: 'Email failed', details: emailData });

  return res.status(200).json({ success: true, sent_to: email, overdue: overdue.length, upcoming: upcoming.length, source });
}
