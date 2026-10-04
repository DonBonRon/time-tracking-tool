const env = process.env;
const bool = (v, dflt) => (v == null || v === '' ? dflt : !/^(0|false|no|off)$/i.test(v));
const int = (v, dflt) => (v == null || v === '' || Number.isNaN(Number(v)) ? dflt : Number(v));

export const config = {
  port: int(env.PORT, 3000),
  host: env.HOST || undefined,
  appUrl: (env.APP_URL || '').replace(/\/$/, ''),
  db: env.DATABASE_URL
    ? { uri: env.DATABASE_URL }
    : {
        host: env.DB_HOST || 'localhost',
        port: int(env.DB_PORT, 3306),
        user: env.DB_USER || 'root',
        password: env.DB_PASSWORD || '',
        database: env.DB_NAME || 'timetrack',
        socketPath: env.DB_SOCKET || undefined,
      },
  // Hinter einem Reverse Proxy (Plesk/Passenger, nginx, Caddy …) auf 1 setzen, damit Client-IP und HTTPS erkannt werden
  trustProxy: int(env.TRUST_PROXY, 1),
  cookieSecure: bool(env.COOKIE_SECURE, true),
  // Optional: Passwort beim ersten Start setzen (danach besser `npm run set-password`)
  initialPassword: env.APP_PASSWORD || '',
  // Geheimer Schlüssel für /api/cron (für Hosting-Cronjobs, falls die App im Leerlauf schläft)
  cronSecret: env.CRON_SECRET || '',
  smtp: {
    host: env.SMTP_HOST || '',
    port: int(env.SMTP_PORT, 587),
    secure: bool(env.SMTP_SECURE, int(env.SMTP_PORT, 587) === 465),
    user: env.SMTP_USER || '',
    pass: env.SMTP_PASS || '',
  },
  mailFrom: env.MAIL_FROM || env.SMTP_USER || '',
  mailTo: env.MAIL_TO || '',
  // Uhrzeit (Stunde, lokale TZ), ab der geplante Berichte verschickt werden
  reportHour: int(env.REPORT_HOUR, 7),
  // Interner Takt für Erinnerungen/Berichte in Sekunden (0 = nur über /api/cron)
  jobInterval: int(env.JOB_INTERVAL, 60),
};

export const mailConfigured = () => Boolean(config.smtp.host && config.mailFrom && config.mailTo);
