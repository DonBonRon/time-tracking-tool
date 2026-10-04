import { mailConfigured, config } from './config.js';
import { sendMail } from './mailer.js';
import { buildReportMail, buildReminderMail, describePeriod } from './report-mail.js';

/** Erinnerung für Timer, die länger als `reminderHours` laufen (einmal pro Timer). */
export async function checkReminders(store, now = Date.now(), log = console) {
  const settings = await store.getSettings();
  if (!settings.reminderHours || !mailConfigured()) return 0;
  const limit = settings.reminderHours * 3600 * 1000;
  const running = await store.runningEntries();
  if (!running.length) return 0;
  const names = new Map((await store.allCustomers()).map((c) => [c.id, c.name]));
  let sent = 0;
  for (const entry of running) {
    if (entry.reminder_sent_at || now - entry.start < limit) continue;
    try {
      await sendMail(buildReminderMail(entry, names.get(entry.customer_id) ?? 'Unbekannter Kunde', settings.reminderHours, now));
      await store.markReminderSent(entry.id, now);
      sent++;
    } catch (err) {
      log.error('Erinnerung konnte nicht gesendet werden:', err.message);
    }
  }
  return sent;
}

/** Fällige Berichte ermitteln: jeweils der zuletzt abgeschlossene Monat bzw. die letzte Woche. */
export function duePeriods(settings, now = Date.now()) {
  const d = new Date(now);
  if (d.getHours() < config.reportHour) return [];
  const periods = [];
  if (settings.monthlyReport) {
    const prev = new Date(d.getFullYear(), d.getMonth() - 1, 1);
    periods.push({ kind: 'month', year: prev.getFullYear(), month: prev.getMonth() });
  }
  if (settings.weeklyReport) {
    periods.push({ kind: 'week', start: new Date(d.getFullYear(), d.getMonth(), d.getDate() - 7).getTime() });
  }
  return periods;
}

export async function checkScheduledReports(store, now = Date.now(), log = console) {
  if (!mailConfigured()) return 0;
  const settings = await store.getSettings();
  // Beim allerersten Lauf keine alten Berichte nachschicken
  const since = await store.kvGet('reportsEnabledSince');
  if (since == null) await store.kvSet('reportsEnabledSince', now);
  let sent = 0;
  for (const period of duePeriods(settings, now)) {
    const { key, to } = describePeriod(period);
    if ((since == null || to <= since) || (await store.reportSent(key))) continue;
    try {
      await sendMail(await buildReportMail(store, period, now));
      await store.markReportSent(key, now);
      sent++;
    } catch (err) {
      log.error(`Bericht ${key} konnte nicht gesendet werden:`, err.message);
    }
  }
  return sent;
}

let running = false;
export async function runJobs(store, now = Date.now(), log = console) {
  if (running) return { reminders: 0, reports: 0 };
  running = true;
  try {
    const reminders = await checkReminders(store, now, log);
    const reports = await checkScheduledReports(store, now, log);
    await store.purgeSessions(now - 400 * 24 * 3600 * 1000);
    return { reminders, reports };
  } finally {
    running = false;
  }
}
