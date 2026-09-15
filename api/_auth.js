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
  if (!r.ok) {
    // Surface the store's own reason (quota, archived, bad token) -- never the token.
    let why = ''; try { why = (await r.text()).slice(0, 160); } catch (e) {}
    throw new Error('kv get failed ' + r.status + (why ? ': ' + why : ''));
  }
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

// Send any Redis command as a JSON array. Throws on a non-OK response.
export async function kvCmd(cmd) {
  const r = await fetch(KV(), {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd)
  });
  if (!r.ok) throw new Error('kv ' + cmd[0] + ' failed ' + r.status);
  return (await r.json()).result;
}

// Requests through the gate, counted per UTC day and kept 35 days.
export function usageKey(d = new Date()) {
  return 'pt_usage_' + d.toISOString().slice(0, 10).replace(/-/g, '');
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
// The free database plan allows 500K requests a month, and running out locks
// the app. So the gate costs ONE request instead of two: a single script checks
// the passcode and session and bumps today's usage counter together. A request
// with no session cookie, once a passcode is known to exist, is refused without
// touching the database at all -- it can only be rejected, never admitted.
const GATE_LUA =
  "local a = redis.call('EXISTS', KEYS[1]) " +
  "local s = redis.call('EXISTS', KEYS[2]) " +
  "local w = redis.call('EXISTS', KEYS[4]) " +
  "local c = redis.call('INCR', KEYS[3]) " +
  "if c == 1 then redis.call('EXPIRE', KEYS[3], 3024000) end " +
  "return {a, s, c, w}";
let CONFIGURED_SEEN = 0;   // when this instance last saw a passcode configured

export async function checkAuth(req) {
  const cookies = parseCookies(req.headers?.cookie || req.headers?.get?.('cookie'));
  const token = cookies.pt_session;
  const hasToken = !!token && /^[a-f0-9]{64}$/.test(token);
  if (!hasToken && Date.now() - CONFIGURED_SEEN < 10 * 60 * 1000) {
    return { ok: false, status: 401, reason: 'no-session', configured: true };
  }

  let out;
  try {
    out = await kvCmd(['EVAL', GATE_LUA, '4', AUTH_KEY,
      'pt_sess_' + (hasToken ? token : 'none'), usageKey(), 'pt_webauthn']);
  } catch (e) {
    // Cannot verify => refuse. Never fail open on an error.
    return { ok: false, status: 503, reason: 'auth-unavailable' };
  }
  const [configured, session, , webauthn] = out;
  if (!configured) { CONFIGURED_SEEN = 0; return { ok: true, reason: 'unconfigured', configured: false }; }
  CONFIGURED_SEEN = Date.now();
  if (!hasToken) return { ok: false, status: 401, reason: 'no-session', configured: true, webauthn: !!webauthn };
  if (!session) return { ok: false, status: 401, reason: 'expired', configured: true, webauthn: !!webauthn };
  return { ok: true, reason: 'session', configured: true, webauthn: !!webauthn };
}

// Convenience for the Node-style handlers.
export async function guard(req, res) {
  const r = await checkAuth(req);
  if (r.ok) return true;
  res.status(r.status).json({ error: 'Not authorised', reason: r.reason });
  return false;
}
