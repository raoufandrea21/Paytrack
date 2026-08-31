// One-tap recovery for data lost to the sync bug on 31-08-2026.
// Session-guarded and idempotent: safe to open more than once.
//
//  - Re-adds the Ammar account (created on the phone while its saves were
//    being refused, so it never reached the server) exactly as it was built:
//    Lender, principal 40,500, three instalments of 11,500.
//  - Re-marks the two payments that were set paid during the same window:
//    Nawayef "Commencement of Construction" and Mayar "50% of foundation works".

import { guard, kvGet } from './_auth.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!(await guard(req, res))) return;

  try {
    const kv = process.env.KV_REST_API_URL, token = process.env.KV_REST_API_TOKEN;
    const raw = await kvGet('paytrack_data');
    if (!raw) return res.status(200).json({ error: 'No data stored.' });
    let data = JSON.parse(raw);
    if (data && typeof data.value === 'string') data = JSON.parse(data.value);
    if (!Array.isArray(data.accs)) return res.status(200).json({ error: 'Unexpected data shape.' });

    const done = [];

    if (!data.accs.some(a => a.id === 'ammar' || a.name === 'Ammar')) {
      data.accs.push({
        id: 'ammar', name: 'Ammar', type: 'Lender', principal: 40500,
        url: '', defer: false, remDays: 1,
        pays: [
          { desc: '1st installment', status: 'notpaid', amount: 11500, dt: '01-09-2026', nd: '', chq: '' },
          { desc: '2nd installment', status: 'notpaid', amount: 11500, dt: '01-10-2026', nd: '', chq: '' },
          { desc: '3rd installment', status: 'notpaid', amount: 11500, dt: '01-11-2026', nd: '', chq: '' }
        ]
      });
      done.push('Ammar account restored (40,500 across 3 instalments)');
    } else done.push('Ammar already present — untouched');

    const markPaid = (accId, descStart) => {
      const a = data.accs.find(x => x.id === accId);
      if (!a) return;
      const p = (a.pays || []).find(x => String(x.desc || '').startsWith(descStart));
      if (p && p.status !== 'paid') {
        p.status = 'paid';
        done.push(a.name + ' — "' + p.desc + '" marked paid');
      } else if (p) done.push(a.name + ' — "' + p.desc + '" already paid');
    };
    markPaid('nawayef', 'Commencement of Construction');
    markPaid('mayar', '50% of foundation works');

    data.saved = new Date().toISOString();
    const w = await fetch(`${kv}/set/paytrack_data`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain' },
      body: JSON.stringify({ value: JSON.stringify(data) })
    });
    if (!w.ok) throw new Error('write failed ' + w.status);

    return res.status(200).json({ ok: true, done, savedAt: data.saved,
      note: 'Now hard-refresh PayTrack on the PC; it will adopt this version.' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
