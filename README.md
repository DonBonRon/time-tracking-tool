# Time Tracking Tool

🇩🇪 [Deutsche Version](README.de.md)

A minimal, self-hosted time tracker for client work: one user, one web app for desktop and phone,
and it keeps working on a weak or missing network connection.

- **Timer:** one-tap start for your most recent clients. Start time and elapsed time are shown live.
- **Add and edit entries afterwards:** enter start and end, or just the duration. Entries past midnight work too, and deleting can be undone.
- **Clients:** a name is all you need. Old clients can be archived instead of deleted.
- **Reports:** current and previous months, per client in h:mm and decimal hours, comparison with the previous month, CSV export.
- **Emails:** automatic monthly report (optionally weekly) with a CSV attachment, and a reminder when a timer has been running for more than 8 hours (configurable).
- **Offline-first:** the app is cached on the device. All changes are stored locally and synced automatically once you're back online.
- **Login:** a single password. After that you stay signed in on each device (sliding 400-day session).

> **Note:** The user interface, emails and CSV export are currently in **German** only.

## Tech stack

| | |
|---|---|
| Server | Node.js ≥ 20, Express, MySQL/MariaDB (`mysql2`, no native build required), Nodemailer |
| Frontend | Plain JavaScript, no build step; PWA with service worker and IndexedDB |
| Dependencies | 3 npm packages (`express`, `mysql2`, `nodemailer`) |

The app creates its database tables on startup. All you need is an empty database.

---

## Installation

### 1. Create a database

Create a MySQL database with its own user in your hosting panel (Plesk, cPanel …), or via SQL:

```sql
CREATE DATABASE timetrack CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'timetrack'@'localhost' IDENTIFIED BY 'a-long-password';
GRANT ALL PRIVILEGES ON timetrack.* TO 'timetrack'@'localhost';
```

### 2. Upload the files and install dependencies

```bash
git clone https://github.com/donbonron/time-tracking-tool.git && cd time-tracking-tool
npm install --omit=dev
cp .env.example .env    # then edit it (database, SMTP, APP_URL …)
```

Instead of a `.env` file you can also set all values as environment variables in your hosting panel.

If you copy the files manually, you need `app.cjs`, `package.json`, `package-lock.json`, `.env.example`
and the folders `server/`, `public/` and `scripts/`. Don't upload `node_modules/`, because `npm install` creates it on the server.

### 3. Set the password

```bash
npm run set-password
```

This needs an interactive terminal (SSH). Without one (for example Plesk's "Run script"), put
`APP_PASSWORD=…` into `.env` and start the app. If no password is stored yet, the app uses this one on startup.
Remove the line afterwards.

### 4. Start the app

**Plesk ("Node.js" extension) / cPanel ("Setup Node.js App"):**

| Setting | Value |
|---|---|
| Node.js version | 20 or newer |
| Application root | the project folder |
| Application startup file | `app.cjs` |
| Environment variables | as in `.env.example` (or a `.env` file in the project folder) |

Then click "NPM install" and "Restart App". The port is set automatically.

**Important for Plesk:** set the **document root** to an empty subfolder such as `/time-tracking-tool/webroot`,
not to `public`. Any files in the document root are served by the web server directly, bypassing the app.
Security headers would then be missing, and app updates would not reach your devices. Also don't put the
project folder inside `httpdocs`, otherwise your `.env` might be downloadable.

**Your own server / VPS:** run the app with systemd or pm2 and put a reverse proxy with HTTPS in front of it.

```ini
# /etc/systemd/system/time-tracking.service
[Unit]
Description=Time Tracking Tool
After=network.target mysql.service

[Service]
WorkingDirectory=/opt/time-tracking-tool
ExecStart=/usr/bin/node app.cjs
Restart=always
User=www-data
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

```
# Caddyfile (automatic HTTPS certificate)
time.example.com {
    reverse_proxy localhost:3000
}
```

### 5. Set up a cron job for reminders and reports (recommended)

The app checks every minute whether a reminder or report is due. Many hosts (Passenger in Plesk/cPanel)
stop idle Node.js apps after a while, though, and then a reminder at night would never be sent. So add a cron job
that calls this URL every 5 minutes:

```bash
# Set CRON_SECRET in .env, e.g. generated with: openssl rand -hex 24
*/5 * * * * curl -fsS "https://time.example.com/api/cron?key=YOUR_CRON_SECRET" > /dev/null
```

In Plesk this is "Scheduled Tasks" → "Fetch a URL". In cPanel it's "Cron Jobs".

### 6. Install on your phone

Open the site in your browser and sign in. Then:

- **iPhone (Safari):** Share → "Add to Home Screen"
- **Android (Chrome):** menu → "Install app"

The app then launches like a regular app, without the browser bar, and works offline.
Installing it is especially worthwhile on iPhone: Safari deletes local data of websites that haven't been used
for 7 days, but this rule doesn't apply to installed apps. Your data is always stored on the server either way.

---

## Usage at a glance

- **Start:** tap a client button. Any running timer is stopped automatically.
- **Stop:** tap "Stopp". Right afterwards you can undo with "Weiterlaufen" (keep running).
- **Forgot to start?** Start the timer, tap "Bearbeiten" (edit) and move the start time back.
- **Forgot to stop?** Tap the entry and correct the end time or duration.
- **Add time:** "+ Zeit nachtragen". Enter the duration as `1:30` or `1,5` and the end time is calculated for you.
- **Reports:** switch months with ‹ ›. Click a client to see their entries.
- **Sync indicator (top right):** green = in sync, yellow = changes pending, grey = offline. Tap it to sync immediately.

## Security

- The password is stored as a scrypt hash. After 5 failed attempts per IP, logins are blocked for 15 minutes. There is also a global rate limit.
- The session is a random 256-bit token in a cookie (`HttpOnly`, `Secure`, `SameSite=Strict`). The database only stores its SHA-256 hash.
- The session is extended automatically on use, so you practically never have to sign in again. "Alle Geräte abmelden" (sign out all devices) or `npm run set-password` invalidates all sessions immediately.
- Write requests from foreign origins are rejected (CSRF protection). On top of that there's a strict Content Security Policy, `X-Frame-Options: DENY` and `noindex`.
- **HTTPS is required.** Without it, neither the session cookie nor the service worker (offline mode) will work.
- Use `TRUST_PROXY=1` (the default) only behind a reverse proxy. If Node.js is directly reachable from the internet, set it to `0`.

## How offline sync works

Every record (client, entry) has a UUID generated in the browser and a modification timestamp.
Changes go straight into IndexedDB and into a queue. On sync, the browser sends the queue to `POST /api/sync`
and gets back every change since its last known state (a monotonically increasing revision number).
On conflicts the newer change wins, and timestamps are aligned with the server clock for this.
Deleted entries are kept as tombstones so that other devices learn about the deletion.

## Development

```bash
npm install
cp .env.example .env        # add database credentials, COOKIE_SECURE=false
npm run dev                 # http://localhost:3000
```

Project structure:

```
app.cjs                Entry point (for Passenger/Plesk/cPanel)
server/
  index.js             Startup, background jobs
  app.js               HTTP API, security headers
  auth.js              Password, sessions, login rate limiting
  db.js                MySQL schema and queries
  jobs.js              Reminders, scheduled reports
  report-mail.js       Email content
public/                Web app (no build step)
  app.js               User interface
  store.js             Local data + sync
  shared/core.js       Reports/formatting (also used by the server)
  sw.js                Service worker (offline cache)
scripts/set-password.js
```

## License

[MIT](LICENSE)
