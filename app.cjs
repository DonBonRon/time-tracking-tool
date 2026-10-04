// Einstiegspunkt für Hosting-Umgebungen, die die Startdatei per require() laden
// (z. B. Phusion Passenger in Plesk/cPanel). Lädt die eigentliche ES-Modul-App.
import('./server/index.js').catch((err) => {
  if (err.code === 'ERR_MODULE_NOT_FOUND') {
    console.error('Abhängigkeiten fehlen. Bitte zuerst "npm install" ausführen (in Plesk: Node.js → "NPM install").');
  }
  console.error(err);
  process.exit(1);
});
