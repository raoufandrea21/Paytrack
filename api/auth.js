// Passcode setup, login, status and logout.
//
// The passcode is never stored. Only a PBKDF2-SHA256 hash (200k iterations)
// with a random per-install salt is kept, so the stored value cannot be
// reversed into the passcode.

import {
  kvGet, kvSet, kvDel, hashPasscode, newSalt, safeEqual,
  AUTH_KEY, SESSION_TTL, newSessionToken, parseCookies, sessionCookie
} from './_auth.js';

const FAIL_KEY = 'pt_auth_fails';
const MAX_FAILS = 10;
const LOCKOUT = 60 * 15;   // 15 minutes

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  const action = (req.query && req.query.action) || (req.body && req.body.action) || 'status';

  try {
    // ── status: does a passcode exist, and am I signed in? ────────────────
    if (action === 'status') {
      const stored = await kvGet(AUTH_KEY);
      if (!stored) return res.status(200).json({ configured: false, authenticated: true });
      const cookies = parseCookies(req.headers.cookie);
      const token = cookies.pt_session;
      let ok = false;
      if (token && /^[a-f0-9]{64}$/.test(token)) ok = !!(await kvGet('pt_sess_' + token));
      let webauthn = false;
      try { webauthn = !!(await kvGet('pt_webauthn')); } catch (e) {}
      return res.status(200).json({ configured: true, authenticated: ok, webauthn });
    }

    if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

    // ── setup: only possible while no passcode exists ─────────────────────
    if (action === 'setup') {
      const existing = await kvGet(AUTH_KEY);
      if (existing) return res.status(409).json({ error: 'A passcode is already set.' });
      const pc = String((req.body && req.body.passcode) || '');
      if (pc.length < 4) return res.status(400).json({ error: 'Use at least 4 characters.' });
      const salt = newSalt();
      await kvSet(AUTH_KEY, JSON.stringify({ salt, hash: hashPasscode(pc, salt), v: 1 }));
      const token = newSessionToken();
      await kvSet('pt_sess_' + token, Date.now(), SESSION_TTL);
      res.setHeader('Set-Cookie', sessionCookie(token, SESSION_TTL));
      return res.status(200).json({ ok: true });
    }

    // ── login ─────────────────────────────────────────────────────────────
    if (action === 'login') {
      const fails = parseInt((await kvGet(FAIL_KEY)) || '0', 10);
      if (fails >= MAX_FAILS) {
        return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
      }
      const stored = await kvGet(AUTH_KEY);
      if (!stored) return res.status(400).json({ error: 'No passcode set.' });
      const { salt, hash } = JSON.parse(stored);
      const pc = String((req.body && req.body.passcode) || '');
      if (!safeEqual(hashPasscode(pc, salt), hash)) {
        await kvSet(FAIL_KEY, fails + 1, LOCKOUT);
        return res.status(401).json({ error: 'Wrong passcode.', remaining: MAX_FAILS - fails - 1 });
      }
      await kvDel(FAIL_KEY);
      const token = newSessionToken();
      await kvSet('pt_sess_' + token, Date.now(), SESSION_TTL);
      res.setHeader('Set-Cookie', sessionCookie(token, SESSION_TTL));
      return res.status(200).json({ ok: true });
    }

    // ── logout ────────────────────────────────────────────────────────────
    if (action === 'logout') {
      const cookies = parseCookies(req.headers.cookie);
      if (cookies.pt_session) await kvDel('pt_sess_' + cookies.pt_session);
      res.setHeader('Set-Cookie', sessionCookie('', 0));
      return res.status(200).json({ ok: true });
    }

    // ── remember that this device has a fingerprint credential ────────────
    // The credential itself lives in the device's secure hardware. This only
    // records that one exists, so the app knows to offer the button.
    if (action === 'webauthn-save') {
      const cookies = parseCookies(req.headers.cookie);
      const token = cookies.pt_session;
      if (!token || !(await kvGet('pt_sess_' + token))) return res.status(401).json({ error: 'Sign in first.' });
      const id = String((req.body && req.body.credentialId) || '');
      if (!id) return res.status(400).json({ error: 'No credential.' });
      await kvSet('pt_webauthn', id);
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
