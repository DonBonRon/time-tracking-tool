// Passwort setzen/ändern: npm run set-password
import '../server/env.js';
import readline from 'node:readline';
import { Writable } from 'node:stream';
import { config } from '../server/config.js';
import { openDb } from '../server/db.js';
import { setPassword } from '../server/auth.js';

function ask(question) {
  // Eingabe nicht im Terminal anzeigen
  let muted = false;
  const output = new Writable({ write(chunk, enc, cb) { if (!muted) process.stdout.write(chunk, enc); cb(); } });
  const rl = readline.createInterface({ input: process.stdin, output, terminal: true });
  return new Promise((resolve) => {
    rl.question(question, (answer) => { rl.close(); process.stdout.write('\n'); resolve(answer); });
    muted = true;
  });
}

const password = process.argv[2] ?? (await ask('Neues Passwort: '));
if (!process.argv[2] && (await ask('Wiederholen: ')) !== password) {
  console.error('Die Passwörter stimmen nicht überein.');
  process.exit(1);
}
const store = await openDb(config.db);
try {
  await setPassword(store, password);
  await store.deleteAllSessions();
  console.log('Passwort gesetzt. Alle bestehenden Anmeldungen wurden beendet.');
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally {
  await store.close();
}
