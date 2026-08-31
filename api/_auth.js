// Shared auth helpers. Files prefixed with _ are not routed as endpoints.
//
// Design note: protection is INERT until a passcode is configured. If no
// passcode exists in KV, every endpoint behaves exactly as it did before, so
// deploying this cannot lock anyone out. But a *failure* to check (KV down,
// bad token) denies rather than allows -- fail-open on error would be a hole.

import crypto from 'node:crypto';

const KV = () => process.env.KV_REST_API_URL;
const TOKEN = () => process.env.KV_REST_API_TOKEN;

export async function kvGet(key) {
  const r = await fetch(`${KV()}/get/${key}`, { headers: { Authorization: `Bearer ${TOKEN()}` } });
  if (!r.ok) throw new Error('kv get failed');
  const j = await r.json();
  let v = j.result ?? null;
  if (v === null) return null;
  // Upstash stores the raw POST body, so a value written as {"value":"..."}
  // comes back wrapped. Unwrap it so old and new writes both read correctly.
  if (typeof v === 'string' && v.startsWith('{"value":')) {
    try { const w = JSON.parse(v); if (typeof w.value === 'string') v = w.value; } catch (e) {}
  }
  return v;
}

export async function kvSet(key, value, ttlSeconds) {
  const path = ttlSeconds ? `${KV()}/setex/${key}/${ttlSeconds}` : `${KV()}/set/${key}`;
  // Upstash takes the request body AS the value. Wrapping it in {"value":...}
  // stores the wrapper itself, which is what broke passcode verification.
  const r = await fetch(path, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN()}`, 'Content-Type': 'text/plain' },
    body: String(value)
  });
  if (!r.ok) throw new Error('kv set failed');
  return true;
}

export async function kvDel(key) {
  await fetch(`${KV()}/del/${key}`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN()}` } });
}

// ── passcode hashing ──────────────────────────────────────────────────────
export function hashPasscode(passcode, salt) {
  return crypto.pbkdf2Sync(String(passcode), salt, 200000, 32, 'sha256').toString('hex');
}

export function newSalt() {
  return crypto.randomBytes(16).toString('hex');
}

// constant-time compare so a wrong guess cannot be timed
export function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

export const AUTH_KEY = 'pt_auth';
export const SESSION_TTL = 60 * 60 * 24 * 30;   // 30 days

export function newSessionToken() {
  return crypto.randomBytes(32).toString('hex');
}

export function parseCookies(header) {
  const out = {};
  (header || '').split(';').forEach(part => {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

export function sessionCookie(token, maxAge) {
  return [
    `pt_session=${token}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    `Max-Age=${maxAge}`
  ].join('; ');
}

// ── the gate ──────────────────────────────────────────────────────────────
// Returns {ok:true} when the request may proceed.
// reason 'unconfigured' means no passcode has been set: open, as before.
export async function checkAuth(req) {
  let stored;
  try {
    stored = await kvGet(AUTH_KEY);
  } catch (e) {
    // Cannot verify => refuse. Never fail open on an error.
    return { ok: false, status: 503, reason: 'auth-unavailable' };
  }
  if (!stored) return { ok: true, reason: 'unconfigured' };

  const cookies = parseCookies(req.headers?.cookie || req.headers?.get?.('cookie'));
  const token = cookies.pt_session;
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return { ok: false, status: 401, reason: 'no-session' };

  let sess;
  try {
    sess = await kvGet('pt_sess_' + token);
  } catch (e) {
    return { ok: false, status: 503, reason: 'auth-unavailable' };
  }
  if (!sess) return { ok: false, status: 401, reason: 'expired' };
  return { ok: true, reason: 'session' };
}

// Convenience for the Node-style handlers.
export async function guard(req, res) {
  const r = await checkAuth(req);
  if (r.ok) return true;
  res.status(r.status).json({ error: 'Not authorised', reason: r.reason });
  return false;
}
