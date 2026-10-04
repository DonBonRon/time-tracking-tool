# Zeiterfassung

🇬🇧 [English version](README.md)

Schlanke Zeiterfassung für Kundenzeiten: ein Nutzer, eine Web-App für Desktop und Smartphone,
funktioniert auch bei schlechtem Netz.

- **Timer** mit Ein-Klick-Start für die zuletzt genutzten Kunden; Startzeit und Laufzeit werden live angezeigt
- **Zeiten nachtragen und bearbeiten** über Start und Ende oder über die Dauer (auch über Mitternacht), mit „Rückgängig“ beim Löschen
- **Kundenverwaltung**: Name genügt; Kunden lassen sich archivieren statt löschen
- **Auswertung** für den aktuellen Monat und frühere Monate, je Kunde in h:mm und Dezimalstunden, Vergleich zum Vormonat, CSV-Export
- **E-Mails**: automatischer Monatsbericht (optional auch wöchentlich) mit CSV-Anhang und Erinnerung, wenn ein Timer länger als 8 Stunden läuft (einstellbar)
- **Offline-fähig**: Die App liegt im Cache, alle Änderungen werden lokal gespeichert und automatisch synchronisiert, sobald Netz da ist
- **Anmeldung**: nur ein Passwort; danach bleibst du auf jedem Gerät dauerhaft angemeldet (gleitend 400 Tage)

Eine Übersicht über Konkurrenzprodukte und die Begründung, welche Funktionen übernommen wurden und welche bewusst nicht,
steht in [docs/konkurrenzanalyse.md](docs/konkurrenzanalyse.md).

## Technik

| | |
|---|---|
| Server | Node.js ≥ 20, Express, MySQL/MariaDB (`mysql2`, kein nativer Build nötig), Nodemailer |
| Frontend | Plain JavaScript, keine Build-Schritte; PWA mit Service Worker und IndexedDB |
| Abhängigkeiten | 3 npm-Pakete (`express`, `mysql2`, `nodemailer`) |

Die Tabellen legt die App beim Start selbst an. Du brauchst nur eine leere Datenbank.

---

## Installation auf dem Webserver

### 1. Datenbank anlegen

Im Hosting-Panel (Plesk, cPanel …) eine MySQL-Datenbank mit eigenem Benutzer anlegen. Per SQL:

```sql
CREATE DATABASE timetrack CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'timetrack'@'localhost' IDENTIFIED BY 'ein-langes-passwort';
GRANT ALL PRIVILEGES ON timetrack.* TO 'timetrack'@'localhost';
```

### 2. Dateien hochladen und Abhängigkeiten installieren

```bash
git clone https://github.com/donbonron/time-tracking-tool.git zeiterfassung && cd zeiterfassung
npm install --omit=dev
cp .env.example .env    # dann anpassen (DB, SMTP, APP_URL …)
```

Statt der `.env`-Datei kannst du alle Werte auch als Umgebungsvariablen im Hosting-Panel eintragen.

Wenn du die Dateien manuell kopierst, brauchst du `app.cjs`, `package.json`, `package-lock.json`, `.env.example`
und die Ordner `server/`, `public/` und `scripts/`. `node_modules/` nicht hochladen, das legt `npm install` auf dem Server an.

### 3. Passwort setzen

```bash
npm run set-password
```

Ohne SSH-Zugang (z. B. „Skript ausführen“ in Plesk) funktioniert die Eingabe nicht. Dann
`APP_PASSWORD=…` in die `.env` eintragen und die App starten. Ist noch kein Passwort gespeichert,
übernimmt sie es beim Start. Danach die Zeile wieder entfernen.

### 4. App starten

**Plesk („Node.js“-Erweiterung) / cPanel („Setup Node.js App“):**

| Einstellung | Wert |
|---|---|
| Node.js-Version | 20 oder neuer |
| Anwendungsstamm | Ordner des Projekts |
| Startdatei | `app.cjs` |
| Umgebungsvariablen | wie in `.env.example` (oder `.env`-Datei im Projektordner) |

Danach „NPM install“ und „App neu starten“ klicken. Der Port wird automatisch gesetzt.

**Wichtig bei Plesk:** Den **Dokumentenstamm** auf einen leeren Unterordner setzen, z. B. `/zeiterfassung/webroot`,
nicht auf `public`. Liegen dort Dateien, liefert der Webserver sie an der App vorbei aus. Dann fehlen
Sicherheits-Header und App-Updates kommen nicht auf den Geräten an. Den Projektordner auch nicht in
`httpdocs` legen, sonst wäre die `.env` womöglich von außen abrufbar.

**Eigener Server / VPS:** mit systemd oder pm2 starten und einen Reverse Proxy mit HTTPS davorsetzen.

```ini
# /etc/systemd/system/zeiterfassung.service
[Unit]
Description=Zeiterfassung
After=network.target mysql.service

[Service]
WorkingDirectory=/opt/zeiterfassung
ExecStart=/usr/bin/node app.cjs
Restart=always
User=www-data
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

```
# Caddyfile (HTTPS-Zertifikat automatisch)
zeit.example.de {
    reverse_proxy localhost:3000
}
```

### 5. Cronjob für Erinnerungen und Berichte einrichten (empfohlen)

Die App prüft intern jede Minute, ob eine Erinnerung oder ein Bericht fällig ist. Viele Hoster
(Passenger in Plesk/cPanel) beenden Node-Apps aber nach einiger Zeit ohne Aufrufe. Dann würde eine
Erinnerung nachts nicht verschickt. Lege deshalb einen Cronjob an, der alle 5 Minuten diese Adresse aufruft:

```bash
# CRON_SECRET in der .env setzen, z. B. mit: openssl rand -hex 24
*/5 * * * * curl -fsS "https://zeit.example.de/api/cron?key=DEIN_CRON_SECRET" > /dev/null
```

In Plesk heißt das „Geplante Aufgaben“ → „URL abrufen“, in cPanel „Cron Jobs“.

### 6. Auf dem Smartphone installieren

Seite im Browser öffnen und anmelden. Danach:

- **iPhone (Safari):** Teilen → „Zum Home-Bildschirm“
- **Android (Chrome):** Menü → „App installieren“

Die App startet dann wie eine normale App, ohne Browserleiste, und funktioniert offline.
Auf dem iPhone ist die Installation besonders sinnvoll: Safari löscht lokale Daten von Webseiten,
die 7 Tage nicht genutzt wurden. Für installierte Apps gilt diese Regel nicht.
Deine Daten liegen in jedem Fall auf dem Server.

---

## Bedienung in Kürze

- **Starten:** Kunden-Button antippen. Ein laufender Timer wird dabei automatisch gestoppt.
- **Stoppen:** „Stopp“. Direkt danach kannst du mit „Weiterlaufen“ rückgängig machen.
- **Vergessen zu starten?** Timer starten, dann „Bearbeiten“ und die Startzeit zurücksetzen.
- **Vergessen zu stoppen?** Eintrag antippen und Ende oder Dauer korrigieren.
- **Nachtragen:** „+ Zeit nachtragen“. Dauer als `1:30` oder `1,5` eingeben, die Endzeit wird automatisch berechnet.
- **Auswertung:** Mit ‹ › zwischen Monaten wechseln. Klick auf einen Kunden zeigt dessen Einträge.
- **Sync-Anzeige oben rechts:** grün = synchron, gelb = Änderungen ausstehend, grau = offline. Antippen synchronisiert sofort.

## Sicherheit

- Das Passwort wird mit scrypt gehasht gespeichert. Nach 5 Fehlversuchen pro IP sind Anmeldungen 15 Minuten gesperrt, zusätzlich gibt es eine globale Bremse.
- Die Session liegt in einem zufälligen 256-Bit-Token im Cookie (`HttpOnly`, `Secure`, `SameSite=Strict`). In der Datenbank steht nur der SHA-256-Hash des Tokens.
- Die Session verlängert sich bei Nutzung automatisch, sodass du praktisch nie neu anmelden musst. Über „Alle Geräte abmelden“ oder `npm run set-password` werden alle Sessions sofort ungültig.
- Schreibende Anfragen von fremden Origins lehnt der Server ab (CSRF-Schutz). Dazu kommen eine strikte Content-Security-Policy, `X-Frame-Options: DENY` und `noindex`.
- **HTTPS ist Pflicht**: Sonst werden weder das Cookie noch der Service Worker (Offline-Modus) genutzt.
- `TRUST_PROXY=1` (Standard) nur hinter einem Reverse Proxy verwenden. Ist Node direkt aus dem Internet erreichbar, auf `0` setzen.

## Wie die Offline-Synchronisation funktioniert

Jeder Datensatz (Kunde, Eintrag) hat eine im Browser erzeugte UUID und einen Änderungszeitstempel.
Änderungen landen sofort in IndexedDB und in einer Warteschlange. Beim Sync schickt der Browser die Warteschlange
an `POST /api/sync` und bekommt alle Änderungen seit seinem letzten Stand zurück (fortlaufende Revisionsnummer).
Bei Konflikten gewinnt die jüngere Änderung. Die Zeitstempel werden dafür an die Serveruhr angeglichen.
Gelöschte Einträge bleiben als Löschmarkierung erhalten, damit andere Geräte die Löschung mitbekommen.

## Entwicklung

```bash
npm install
cp .env.example .env        # DB-Zugang eintragen, COOKIE_SECURE=false
npm run dev                 # http://localhost:3000

# Tests (Integrationstests brauchen eine leere Test-Datenbank)
TEST_DATABASE_URL=mysql://user:pass@localhost/timetrack_test npm test
```

Projektstruktur:

```
app.cjs                Einstiegspunkt (für Passenger/Plesk/cPanel)
server/
  index.js             Start, Hintergrund-Jobs
  app.js               HTTP-API, Sicherheits-Header
  auth.js              Passwort, Sessions, Login-Bremse
  db.js                MySQL-Schema und Zugriffe
  jobs.js              Erinnerungen, geplante Berichte
  report-mail.js       Inhalt der E-Mails
public/                Web-App (ohne Build-Schritt)
  app.js               Oberfläche
  store.js             lokale Daten + Synchronisation
  shared/core.js       Auswertung/Formatierung (auch vom Server genutzt)
  sw.js                Service Worker (Offline-Cache)
scripts/set-password.js
test/
```

## Lizenz

[MIT](LICENSE)
