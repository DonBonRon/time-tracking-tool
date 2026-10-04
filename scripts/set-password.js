// Passwort setzen/ändern: npm run set-password
import '../server/env.js';
import readline from 'node:readline';
import { Writable } from 'node:stream';
import { config } from '../server/config.js';

let openDb, setPassword;
try {
  ({ openDb } = await import('../server/db.js'));
  ({ setPassword } = await import('../server/auth.js'));
} catch (err) {
  if (err.code !== 'ERR_MODULE_NOT_FOUND') throw err;
  console.error('Abhängigkeiten fehlen. Bitte zuerst "npm install" ausführen (in Plesk: Node.js → "NPM install").');
  process.exit(1);
}

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

if (!process.argv[2] && !process.stdin.isTTY) {
  console.error([
    'Keine Eingabe möglich (kein Terminal, z. B. "Skript ausführen" in Plesk).',
    'Alternativen:',
    '  • In der .env APP_PASSWORD=… eintragen, App neu starten, Zeile danach wieder entfernen',
    '  • per SSH im Terminal "npm run set-password" ausführen',
  ].join('\n'));
  process.exit(1);
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
