import nodemailer from 'nodemailer';
import { config, mailConfigured } from './config.js';

let transport;

export function getTransport() {
  if (!mailConfigured()) return null;
  transport ??= nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
  });
  return transport;
}

/** Für Tests: eigenen Transport einsetzen (z. B. { sendMail: async (m) => … }). */
export function setTransport(t) {
  transport = t;
}

export async function sendMail({ subject, text, html, attachments }) {
  const t = transport ?? getTransport();
  if (!t) throw new Error('E-Mail ist nicht konfiguriert (SMTP_HOST, MAIL_FROM, MAIL_TO).');
  return t.sendMail({ from: config.mailFrom, to: config.mailTo, subject, text, html, attachments });
}
