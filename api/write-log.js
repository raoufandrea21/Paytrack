// Read the server-side audit of who wrote what. Session-guarded.
import { guard, kvGet } from './_auth.js';
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!(await guard(req, res))) return;
  try {
    const raw = await kvGet('pt_write_log');
    return res.status(200).json({ writes: raw ? JSON.parse(raw) : [] });
  } catch (e) { return res.status(500).json({ error: e.message }); }
}
