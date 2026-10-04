// Einstiegspunkt für Hosting-Umgebungen, die die Startdatei per require() laden
// (z. B. Phusion Passenger in Plesk/cPanel). Lädt die eigentliche ES-Modul-App.
import('./server/index.js').catch((err) => {
  console.error(err);
  process.exit(1);
});
