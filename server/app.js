import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { config, mailConfigured } from './config.js';
import { createAuth } from './auth.js';
import { sendMail } from './mailer.js';
import { buildReportMail } from './report-mail.js';
import { runJobs } from './jobs.js';
import { CUSTOMER_FIELDS, ENTRY_FIELDS } from './db.js';

const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');
const MAX_BATCH = 5000;

// ---- Validierung der Sync-Daten ----
const isId = (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v);
const isTs = (v) => Number.isSafeInteger(v) && v >= 0 && v < 32503680000000; // < Jahr 3000

function validCustomer(c) {
  return c && isId(c.id) && typeof c.name === 'string' && c.name.trim().length > 0 && c.name.length <= 200
    && isTs(c.updated_at);
}

function validEntry(e) {
  return e && isId(e.id) && isId(e.customer_id) && isTs(e.start) && (e.end == null || (isTs(e.end) && e.end >= e.start))
    && (e.note == null || (typeof e.note === 'string' && e.note.length <= 2000)) && isTs(e.updated_at);
}

// Optional: Liste der geänderten Felder (nur bekannte Feldnamen, sonst gelten alle als geändert)
const normFields = (fields, allowed) => (Array.isArray(fields) ? allowed.filter((f) => fields.includes(f)) : undefined);

const normCustomer = (c) => ({
  id: c.id, name: c.name.trim(), archived: Boolean(c.archived), deleted: Boolean(c.deleted), updated_at: c.updated_at,
  fields: normFields(c.fields, CUSTOMER_FIELDS),
});
const normEntry = (e) => ({
  id: e.id, customer_id: e.customer_id, start: e.start, end: e.end ?? null, note: e.note ?? '',
  deleted: Boolean(e.deleted), updated_at: e.updated_at, fields: normFields(e.fields, ENTRY_FIELDS),
});

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function hashDir(dir) {
  const hash = crypto.createHash('sha256');
  const walk = (d) => {
    for (const name of fs.readdirSync(d).sort()) {
      const p = path.join(d, name);
      if (fs.statSync(p).isDirectory()) walk(p);
      else hash.update(name).update(fs.readFileSync(p));
    }
  };
  walk(dir);
  return hash.digest('hex').slice(0, 12);
}

function maskEmail(addr) {
  return addr.replace(/^(.)(.*)(@.*)$/, (_, a, b, c) => a + '*'.repeat(Math.min(b.length, 5)) + c);
}

export function createApp(store, { log = console } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);
  const auth = createAuth(store, { cookieSecure: config.cookieSecure });

  app.use((req, res, next) => {
    res.set({
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; manifest-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    });
    if (req.secure) res.set('Strict-Transport-Security', 'max-age=31536000');
    next();
  });

  // Service Worker mit Versions-Hash über alle App-Dateien ausliefern
  const swSource = fs.readFileSync(path.join(publicDir, 'sw.js'), 'utf8')
    .replace("'__VERSION__'", `'${hashDir(publicDir)}'`);
  app.get('/sw.js', (req, res) => {
    res.set({ 'Cache-Control': 'no-cache', 'Content-Type': 'text/javascript; charset=utf-8' }).send(swSource);
  });

  // ---- Statische Dateien (App-Shell); Caching übernimmt der Service Worker ----
  app.use(express.static(publicDir, {
    index: 'index.html',
    setHeaders(res, file) {
      res.set('Cache-Control', 'no-cache');
      if (file.endsWith('.webmanifest')) res.type('application/manifest+json');
    },
  }));

  const api = express.Router();
  api.use(express.json({ limit: '2mb' }));
  api.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    // CSRF-Schutz zusätzlich zu SameSite=Strict: fremde Origins ablehnen
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const origin = req.get('origin');
      if (origin) {
        let host;
        try { host = new URL(origin).host; } catch { host = null; }
        if (host !== req.get('host')) return res.status(403).json({ error: 'Ungültige Herkunft.' });
      }
    }
    next();
  });
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

  api.post('/login', wrap(auth.login));
  api.post('/logout', wrap(auth.logout));

  // Cronjob-Endpunkt (für Hosting, bei dem die App im Leerlauf beendet wird)
  api.all('/cron', wrap(async (req, res) => {
    const key = req.query.key ?? req.get('x-cron-key');
    if (!config.cronSecret || !key || !safeEqual(key, config.cronSecret)) return res.status(403).json({ error: 'Forbidden' });
    res.json(await runJobs(store, Date.now(), log));
  }));

  api.use(wrap(auth.requireSession));

  api.get('/session', (req, res) => res.json({ ok: true }));
  api.post('/logout-all', wrap(auth.logoutAll));
  api.post('/password', wrap(auth.changePassword));

  api.post('/sync', wrap(async (req, res) => {
    const { since = 0, changes = {} } = req.body ?? {};
    const customers = Array.isArray(changes.customers) ? changes.customers : [];
    const entries = Array.isArray(changes.entries) ? changes.entries : [];
    if (!Number.isSafeInteger(since) || since < 0) return res.status(400).json({ error: 'Ungültiges since.' });
    if (customers.length + entries.length > MAX_BATCH) return res.status(413).json({ error: 'Zu viele Änderungen auf einmal.' });
    const badC = customers.find((c) => !validCustomer(c));
    const badE = entries.find((e) => !validEntry(e));
    if (badC || badE) return res.status(400).json({ error: 'Ungültige Daten.', id: (badC ?? badE)?.id ?? null });

    const applied = await store.applyChanges({ customers: customers.map(normCustomer), entries: entries.map(normEntry) });
    const rev = await store.currentRev();
    const delta = await store.changesSince(since, { customerIds: customers.map((c) => c.id), entryIds: entries.map((e) => e.id) });
    res.json({ rev, applied, ...delta, serverTime: Date.now() });
  }));

  api.get('/settings', wrap(async (req, res) => {
    res.json({
      ...(await store.getSettings()),
      mailConfigured: mailConfigured(),
      mailTo: config.mailTo ? maskEmail(config.mailTo) : '',
      reportHour: config.reportHour,
    });
  }));

  api.put('/settings', wrap(async (req, res) => {
    try {
      res.json(await store.saveSettings(req.body ?? {}));
    } catch (err) {
      if (err instanceof RangeError) return res.status(400).json({ error: err.message });
      throw err;
    }
  }));

  api.post('/report/send', wrap(async (req, res) => {
    const { year, month } = req.body ?? {};
    if (!Number.isInteger(year) || !Number.isInteger(month) || month < 0 || month > 11) {
      return res.status(400).json({ error: 'Ungültiger Monat.' });
    }
    if (!mailConfigured()) return res.status(400).json({ error: 'E-Mail ist auf dem Server nicht konfiguriert.' });
    await sendMail(await buildReportMail(store, { kind: 'month', year, month }));
    res.json({ ok: true });
  }));

  app.use('/api', api);
  app.use('/api', (req, res) => res.status(404).json({ error: 'Nicht gefunden.' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Ungültiges JSON.' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Anfrage zu groß.' });
    log.error(err);
    res.status(500).json({ error: err.code === 'EAUTH' || err.responseCode ? `Mailversand fehlgeschlagen: ${err.message}` : 'Interner Fehler.' });
  });

  return app;
}
