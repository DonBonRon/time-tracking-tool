import {
  buildReport, reportToCSV, formatDuration, formatHours, formatDate, formatTime, formatDateTime,
  monthRange, weekRange, monthLabel, entryDuration,
} from '../public/shared/core.js';
import { config } from './config.js';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Zeitraum-Beschreibung: { kind: 'month', year, month } | { kind: 'week', start } */
export function describePeriod(period) {
  if (period.kind === 'month') {
    const [from, to] = monthRange(period.year, period.month);
    return { from, to, label: monthLabel(period.year, period.month), key: `month:${period.year}-${String(period.month + 1).padStart(2, '0')}` };
  }
  const [from, to] = weekRange(period.start);
  return { from, to, label: `Woche ${formatDate(from)} – ${formatDate(to - 1)}`, key: `week:${new Date(from).toISOString().slice(0, 10)}` };
}

export async function buildReportMail(store, period, now = Date.now()) {
  const { from, to, label } = describePeriod(period);
  const [customers, entries] = await Promise.all([store.allCustomers(), store.entriesBetween(from, to)]);
  const report = buildReport({ entries, customers, from, to, now });
  const names = new Map(customers.map((c) => [c.id, c.name]));

  const lines = [
    `Zeiterfassung – ${label}`,
    '',
    ...report.byCustomer.map((c) => `${c.name}: ${formatDuration(c.ms)} h (${formatHours(c.ms)} h, ${c.count} ${c.count === 1 ? 'Eintrag' : 'Einträge'})`),
    '',
    `Gesamt: ${formatDuration(report.total)} h (${formatHours(report.total)} h)`,
  ];
  if (report.running) lines.push('', `Hinweis: ${report.running} Timer läuft noch (bis jetzt mitgezählt).`);
  if (!report.count) lines.splice(2, 0, 'Keine Einträge in diesem Zeitraum.');

  const rows = report.byCustomer.map((c) =>
    `<tr><td style="padding:4px 12px 4px 0">${esc(c.name)}</td><td style="padding:4px 12px;text-align:right">${formatDuration(c.ms)}</td><td style="padding:4px 0 4px 12px;text-align:right">${formatHours(c.ms)}</td></tr>`).join('');
  const detail = report.entries.map((e) =>
    `<tr><td style="padding:2px 10px 2px 0">${formatDate(e.start)}</td><td style="padding:2px 10px">${formatTime(e.start)}–${e.end == null ? 'läuft' : formatTime(e.end)}</td><td style="padding:2px 10px">${esc(names.get(e.customer_id) ?? '')}</td><td style="padding:2px 10px;text-align:right">${formatDuration(entryDuration(e, now))}</td><td style="padding:2px 0 2px 10px;color:#555">${esc(e.note ?? '')}</td></tr>`).join('');

  const html = `<!doctype html><html><body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#111">
<h2 style="margin:0 0 12px">Zeiterfassung – ${esc(label)}</h2>
${report.count ? `<table style="border-collapse:collapse;font-size:15px">
<tr style="color:#666;font-size:13px"><th style="text-align:left;padding:4px 12px 4px 0">Kunde</th><th style="text-align:right;padding:4px 12px">h:mm</th><th style="text-align:right;padding:4px 0 4px 12px">Stunden</th></tr>
${rows}
<tr style="font-weight:bold;border-top:1px solid #ccc"><td style="padding:6px 12px 4px 0">Gesamt</td><td style="padding:6px 12px 4px;text-align:right">${formatDuration(report.total)}</td><td style="padding:6px 0 4px 12px;text-align:right">${formatHours(report.total)}</td></tr>
</table>
${report.running ? `<p style="color:#a15c00">Hinweis: ${report.running} Timer läuft noch (bis jetzt mitgezählt).</p>` : ''}
<h3 style="margin:24px 0 8px;font-size:15px">Einträge</h3>
<table style="border-collapse:collapse;font-size:13px">${detail}</table>` : '<p>Keine Einträge in diesem Zeitraum.</p>'}
${config.appUrl ? `<p style="margin-top:24px"><a href="${esc(config.appUrl)}">Zeiterfassung öffnen</a></p>` : ''}
<p style="color:#888;font-size:12px">Die Einträge liegen zusätzlich als CSV-Datei im Anhang.</p>
</body></html>`;

  const fileLabel = label.replace(/[^\wäöüÄÖÜß.-]+/g, '_');
  return {
    subject: `Zeiterfassung ${label}: ${formatDuration(report.total)} h`,
    text: lines.join('\n'),
    html,
    attachments: [{ filename: `zeiterfassung_${fileLabel}.csv`, content: reportToCSV(report, customers, now), contentType: 'text/csv; charset=utf-8' }],
  };
}

export function buildReminderMail(entry, customerName, hours, now = Date.now()) {
  const runFor = formatDuration(now - entry.start);
  const text = [
    `Der Timer für „${customerName}“ läuft seit ${runFor} h (gestartet ${formatDateTime(entry.start)}).`,
    '',
    `Falls du vergessen hast, ihn zu stoppen, kannst du die Endzeit in der App nachträglich korrigieren.`,
    config.appUrl ? `\n${config.appUrl}` : '',
  ].join('\n');
  const html = `<!doctype html><html><body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#111">
<p>Der Timer für <strong>${esc(customerName)}</strong> läuft seit <strong>${runFor} h</strong> (gestartet ${esc(formatDateTime(entry.start))}).</p>
<p>Falls du vergessen hast, ihn zu stoppen, kannst du die Endzeit in der App nachträglich korrigieren.</p>
${config.appUrl ? `<p><a href="${esc(config.appUrl)}">Zeiterfassung öffnen</a></p>` : ''}
</body></html>`;
  return { subject: `⏱ Timer läuft seit über ${hours} Stunden: ${customerName}`, text, html };
}
