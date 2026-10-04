import './env.js';
import { config, mailConfigured } from './config.js';
import { openDb } from './db.js';
import { createApp } from './app.js';
import { setPassword } from './auth.js';
import { runJobs } from './jobs.js';

const store = await openDb(config.db);

if (!(await store.kvGet('password'))) {
  if (config.initialPassword) {
    await setPassword(store, config.initialPassword);
    console.log('Passwort aus APP_PASSWORD gesetzt. Du kannst APP_PASSWORD jetzt aus der Konfiguration entfernen.');
  } else {
    console.warn('WARNUNG: Kein Passwort gesetzt. Bitte `npm run set-password` ausführen oder APP_PASSWORD setzen.');
  }
}
if (!mailConfigured()) console.warn('Hinweis: SMTP nicht konfiguriert – Erinnerungen und Berichte per Mail sind deaktiviert.');

const app = createApp(store);
const server = app.listen(config.port, config.host, () => {
  console.log(`Zeiterfassung läuft auf Port ${config.port}`);
});

if (config.jobInterval > 0) {
  const tick = () => runJobs(store).catch((err) => console.error('Job-Fehler:', err));
  setTimeout(tick, 5000);
  setInterval(tick, config.jobInterval * 1000).unref();
}

const shutdown = () => server.close(() => store.close().finally(() => process.exit(0)));
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
