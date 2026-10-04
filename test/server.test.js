// Integrationstests gegen eine echte MySQL/MariaDB-Datenbank.
// Ausführen mit: TEST_DATABASE_URL=mysql://user:pass@localhost/timetrack_test npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

const DB_URL = process.env.TEST_DATABASE_URL;
process.env.TZ = 'Europe/Berlin';
Object.assign(process.env, {
  COOKIE_SECURE: 'false', SMTP_HOST: 'smtp.example.invalid', MAIL_FROM: 'app@example.com', MAIL_TO: 'me@example.com',
  CRON_SECRET: 'test-cron-secret', REPORT_HOUR: '7',
});

const skip = !DB_URL && 'TEST_DATABASE_URL nicht gesetzt';
let store, server, base, cookie, mails, mod;

before(async () => {
  if (skip) return;
  const { openDb } = await import('../server/db.js');
  const { createApp } = await import('../server/app.js');
  const { setPassword } = await import('../server/auth.js');
  const mailer = await import('../server/mailer.js');
  mod = { jobs: await import('../server/jobs.js') };
  store = await openDb({ uri: DB_URL });
  for (const t of ['customers', 'entries', 'kv', 'sessions', 'report_log']) await store.pool.query(`DELETE FROM ${t}`);
  await store.pool.query('UPDATE rev_counter SET value = 0');
  await setPassword(store, 'richtig-geheim');
  mails = [];
  mailer.setTransport({ sendMail: async (m) => { mails.push(m); return { messageId: 'x' }; } });
  const quiet = { error() {}, log() {} };
  server = createApp(store, { log: quiet }).listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (skip) return;
  server.close();
  await store.close();
});

const post = (path, body, headers = {}) => fetch(base + path, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}), ...headers }, body: JSON.stringify(body),
});

test('Login: falsches Passwort, Sperre, richtiges Passwort', { skip }, async () => {
  assert.equal((await fetch(base + '/api/session')).status, 401);
  const bad = await post('/api/login', { password: 'falsch' });
  assert.equal(bad.status, 401);
  const ok = await post('/api/login', { password: 'richtig-geheim' });
  assert.equal(ok.status, 200);
  const setCookie = ok.headers.get('set-cookie');
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /SameSite=Strict/i);
  cookie = setCookie.split(';')[0];
  assert.equal((await fetch(base + '/api/session', { headers: { cookie } })).status, 200);
});

test('Login-Bremse nach 5 Fehlversuchen', { skip }, async () => {
  const saved = cookie;
  cookie = null;
  const ip = { 'X-Forwarded-For': '203.0.113.9' };
  for (let i = 0; i < 5; i++) await post('/api/login', { password: 'nein' }, ip);
  const blocked = await post('/api/login', { password: 'richtig-geheim' }, ip);
  assert.equal(blocked.status, 429);
  cookie = saved;
});

test('Sync: Anlegen, Last-Write-Wins, Delta seit Revision', { skip }, async () => {
  const c = { id: 'cust-1', name: 'Kunde A', updated_at: 1000 };
  const e = { id: 'entry-1', customer_id: 'cust-1', start: 1_000_000, end: 4_600_000, note: 'x', updated_at: 1000 };
  let r = await (await post('/api/sync', { since: 0, changes: { customers: [c], entries: [e] } })).json();
  assert.equal(r.applied, 2);
  assert.equal(r.customers.length, 1);
  const rev = r.rev;

  // Ältere Änderung wird verworfen
  r = await (await post('/api/sync', { since: rev, changes: { entries: [{ ...e, note: 'alt', updated_at: 500 }] } })).json();
  assert.equal(r.applied, 0);
  assert.equal(r.entries.length, 0);

  // Neuere Änderung gewinnt
  r = await (await post('/api/sync', { since: rev, changes: { entries: [{ ...e, note: 'neu', updated_at: 2000 }] } })).json();
  assert.equal(r.applied, 1);
  assert.equal(r.entries[0].note, 'neu');
  assert.equal(typeof r.entries[0].start, 'number');
});

test('Sync: ungültige Daten und fremde Origin werden abgelehnt', { skip }, async () => {
  const bad = await post('/api/sync', { since: 0, changes: { entries: [{ id: 'e', customer_id: 'c', start: 10, end: 5, updated_at: 1 }] } });
  assert.equal(bad.status, 400);
  const csrf = await post('/api/sync', { since: 0 }, { Origin: 'https://evil.example' });
  assert.equal(csrf.status, 403);
});

test('Einstellungen lesen und validieren', { skip }, async () => {
  const s = await (await fetch(base + '/api/settings', { headers: { cookie } })).json();
  assert.equal(s.reminderHours, 8);
  assert.equal(s.mailConfigured, true);
  assert.equal(s.mailTo, 'm*@example.com');
  const put = (body) => fetch(base + '/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json', cookie }, body: JSON.stringify(body) });
  assert.equal((await put({ reminderHours: 100 })).status, 400);
  assert.equal((await (await put({ weeklyReport: true })).json()).weeklyReport, true);
  await put({ weeklyReport: false });
});

test('Erinnerung nach 8 Stunden – genau einmal', { skip }, async () => {
  mails.length = 0;
  const now = Date.now();
  await post('/api/sync', { since: 0, changes: { entries: [
    { id: 'run-1', customer_id: 'cust-1', start: now - 9 * 3600000, end: null, note: '', updated_at: now },
    { id: 'run-2', customer_id: 'cust-1', start: now - 2 * 3600000, end: null, note: '', updated_at: now },
  ] } });
  assert.equal(await mod.jobs.checkReminders(store, now), 1);
  assert.match(mails[0].subject, /Kunde A/);
  assert.equal(await mod.jobs.checkReminders(store, now + 60000), 0);
  // Startzeit geändert -> Erinnerung wird zurückgesetzt
  await post('/api/sync', { since: 0, changes: { entries: [
    { id: 'run-1', customer_id: 'cust-1', start: now - 10 * 3600000, end: null, note: '', updated_at: now + 1 },
  ] } });
  assert.equal(await mod.jobs.checkReminders(store, now + 120000), 1);
  // Aufräumen: Timer beenden
  await post('/api/sync', { since: 0, changes: { entries: [
    { id: 'run-1', customer_id: 'cust-1', start: now - 10 * 3600000, end: now, note: '', updated_at: now + 2, deleted: true },
    { id: 'run-2', customer_id: 'cust-1', start: now - 2 * 3600000, end: now, note: '', updated_at: now + 2, deleted: true },
  ] } });
});

test('Monatsbericht: erst nach Aktivierung, dann einmal pro Monat', { skip }, async () => {
  mails.length = 0;
  const oct = new Date(2026, 9, 15, 10).getTime();
  await post('/api/sync', { since: 0, changes: { entries: [
    { id: 'oct-1', customer_id: 'cust-1', start: oct, end: oct + 3 * 3600000, note: 'Okt', updated_at: Date.now() },
  ] } });
  await store.kvSet('reportsEnabledSince', new Date(2026, 9, 20).getTime());
  const nov1early = new Date(2026, 10, 1, 6).getTime();
  const nov1 = new Date(2026, 10, 1, 8).getTime();
  assert.equal(await mod.jobs.checkScheduledReports(store, nov1early), 0); // vor REPORT_HOUR
  assert.equal(await mod.jobs.checkScheduledReports(store, nov1), 1);
  assert.match(mails[0].subject, /Oktober 2026: 3:00 h/);
  assert.equal(mails[0].attachments[0].filename, 'zeiterfassung_Oktober_2026.csv');
  assert.equal(await mod.jobs.checkScheduledReports(store, nov1 + 3600000), 0);
  // September lag vor der Aktivierung -> kein Nachversand
  assert.equal(await mod.jobs.checkScheduledReports(store, new Date(2026, 9, 21, 8).getTime()), 0);
});

test('Cron-Endpunkt nur mit Schlüssel', { skip }, async () => {
  assert.equal((await fetch(base + '/api/cron')).status, 403);
  assert.equal((await fetch(base + '/api/cron?key=falsch')).status, 403);
  const r = await fetch(base + '/api/cron?key=test-cron-secret');
  assert.equal(r.status, 200);
});

test('Bericht manuell senden', { skip }, async () => {
  mails.length = 0;
  const r = await post('/api/report/send', { year: 2026, month: 9 });
  assert.equal(r.status, 200);
  assert.equal(mails.length, 1);
  assert.match(mails[0].html, /Kunde A/);
});

test('Abmelden aller Geräte macht Session ungültig', { skip }, async () => {
  assert.equal((await post('/api/logout-all', {})).status, 200);
  assert.equal((await fetch(base + '/api/session', { headers: { cookie } })).status, 401);
});
