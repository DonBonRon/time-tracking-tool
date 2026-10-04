import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);
const SCRYPT_PARAMS = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export const COOKIE_NAME = 'tt_session';
// Browser begrenzen Cookies auf max. 400 Tage; die Session verlängert sich bei jeder Nutzung.
export const SESSION_MAX_AGE = 400 * 24 * 3600 * 1000;
const TOUCH_INTERVAL = 12 * 3600 * 1000;

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, 64, SCRYPT_PARAMS);
  return `scrypt$${SCRYPT_PARAMS.N}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false;
  const [algo, n, saltB64, keyB64] = stored.split('$');
  if (algo !== 'scrypt') return false;
  const expected = Buffer.from(keyB64, 'base64');
  const key = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length, { ...SCRYPT_PARAMS, N: Number(n) });
  return crypto.timingSafeEqual(key, expected);
}

export async function setPassword(store, password) {
  if (typeof password !== 'string' || password.length < 8) throw new Error('Das Passwort muss mindestens 8 Zeichen lang sein.');
  await store.kvSet('password', await hashPassword(password));
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function setSessionCookie(res, token, secure) {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure,
    sameSite: 'strict',
    maxAge: SESSION_MAX_AGE,
    path: '/',
  });
}

/** Einfache Bremse gegen Passwort-Raten: pro IP und global. */
export class LoginLimiter {
  constructor({ maxPerIp = 5, maxGlobal = 30, windowMs = 15 * 60 * 1000 } = {}) {
    Object.assign(this, { maxPerIp, maxGlobal, windowMs });
    this.failures = new Map(); // ip -> [timestamps]
    this.global = [];
  }

  #prune(list, now) {
    while (list.length && list[0] < now - this.windowMs) list.shift();
  }

  /** Millisekunden bis zum nächsten erlaubten Versuch (0 = erlaubt). */
  retryAfter(ip, now = Date.now()) {
    const list = this.failures.get(ip) ?? [];
    this.#prune(list, now);
    this.#prune(this.global, now);
    if (list.length >= this.maxPerIp) return list[0] + this.windowMs - now;
    if (this.global.length >= this.maxGlobal) return this.global[0] + this.windowMs - now;
    return 0;
  }

  fail(ip, now = Date.now()) {
    const list = this.failures.get(ip) ?? [];
    list.push(now);
    this.failures.set(ip, list);
    this.global.push(now);
  }

  success(ip) {
    this.failures.delete(ip);
  }
}

export function createAuth(store, { cookieSecure }) {
  const limiter = new LoginLimiter();

  async function login(req, res) {
    const ip = req.ip;
    const wait = limiter.retryAfter(ip);
    if (wait > 0) {
      res.set('Retry-After', String(Math.ceil(wait / 1000)));
      return res.status(429).json({ error: `Zu viele Fehlversuche. Bitte in ${Math.ceil(wait / 60000)} Minuten erneut versuchen.` });
    }
    const password = req.body?.password;
    const stored = await store.kvGet('password');
    if (!stored) return res.status(503).json({ error: 'Es ist noch kein Passwort gesetzt (siehe README: npm run set-password).' });
    const ok = typeof password === 'string' && password.length <= 1024 && (await verifyPassword(password, stored));
    if (!ok) {
      limiter.fail(ip);
      return res.status(401).json({ error: 'Falsches Passwort.' });
    }
    limiter.success(ip);
    const token = crypto.randomBytes(32).toString('base64url');
    await store.createSession(sha256(token), String(req.get('user-agent') ?? ''), Date.now());
    setSessionCookie(res, token, cookieSecure);
    res.json({ ok: true });
  }

  async function logout(req, res) {
    const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
    if (token) await store.deleteSession(sha256(token));
    res.clearCookie(COOKIE_NAME, { path: '/' });
    res.json({ ok: true });
  }

  async function logoutAll(req, res) {
    await store.deleteAllSessions();
    res.clearCookie(COOKIE_NAME, { path: '/' });
    res.json({ ok: true });
  }

  /** Middleware: verlangt eine gültige Session und verlängert sie gleitend. */
  async function requireSession(req, res, next) {
    const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
    if (!token) return res.status(401).json({ error: 'Nicht angemeldet.' });
    const hash = sha256(token);
    const session = await store.getSession(hash);
    const now = Date.now();
    if (!session || session.last_seen < now - SESSION_MAX_AGE) {
      return res.status(401).json({ error: 'Sitzung abgelaufen.' });
    }
    if (now - session.last_seen > TOUCH_INTERVAL) {
      await store.touchSession(hash, now);
      setSessionCookie(res, token, cookieSecure);
    }
    next();
  }

  async function changePassword(req, res) {
    const { current, next: newPassword } = req.body ?? {};
    const stored = await store.kvGet('password');
    if (typeof current !== 'string' || !(await verifyPassword(current, stored))) {
      return res.status(400).json({ error: 'Aktuelles Passwort ist falsch.' });
    }
    try {
      await setPassword(store, newPassword);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
    // Alle anderen Geräte abmelden, aktuelles Gerät neu anmelden
    await store.deleteAllSessions();
    const token = crypto.randomBytes(32).toString('base64url');
    await store.createSession(sha256(token), String(req.get('user-agent') ?? ''), Date.now());
    setSessionCookie(res, token, cookieSecure);
    res.json({ ok: true });
  }

  return { login, logout, logoutAll, requireSession, changePassword, limiter };
}
