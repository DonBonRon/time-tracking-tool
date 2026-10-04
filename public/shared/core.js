// Gemeinsame Logik für Browser und Server (ES-Modul ohne Abhängigkeiten).
// Alle Zeitpunkte sind Millisekunden seit Epoch (UTC); Monats-/Tagesgrenzen
// werden in der lokalen Zeitzone berechnet (Browser bzw. TZ des Servers).

export const MONTH_NAMES = [
  'Januar', 'Februar', 'März', 'April', 'Mai', 'Juni',
  'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember',
];
export const WEEKDAYS = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];

/** [start, end) eines Monats; month ist 0-basiert. */
export function monthRange(year, month) {
  return [new Date(year, month, 1).getTime(), new Date(year, month + 1, 1).getTime()];
}

/** [start, end) der Woche (Mo–So), in der `ts` liegt. */
export function weekRange(ts) {
  const d = new Date(ts);
  const offset = (d.getDay() + 6) % 7; // Montag = 0
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate() - offset);
  const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 7);
  return [start.getTime(), end.getTime()];
}

export function monthLabel(year, month) {
  return `${MONTH_NAMES[month]} ${year}`;
}

export function entryDuration(entry, now = Date.now()) {
  const end = entry.end ?? now;
  return Math.max(0, end - entry.start);
}

/** 5400000 → "1:30" */
export function formatDuration(ms) {
  const totalMin = Math.floor(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${h}:${String(m).padStart(2, '0')}`;
}

/** 5400000 → "01:30:00" */
export function formatClock(ms) {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/** 5400000 → "1,50" (Dezimalstunden, deutsches Format) */
export function formatHours(ms) {
  return (ms / 3600000).toFixed(2).replace('.', ',');
}

const pad = (n) => String(n).padStart(2, '0');

export function formatDate(ts) {
  const d = new Date(ts);
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`;
}

export function formatTime(ts) {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function formatDateTime(ts) {
  return `${WEEKDAYS[new Date(ts).getDay()]} ${formatDate(ts)} ${formatTime(ts)}`;
}

/** Wert für <input type="date"> */
export function toDateInput(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Wert für <input type="time"> */
export function toTimeInput(ts) {
  return formatTime(ts);
}

/** "2026-10-04" + "09:15" → Timestamp (lokale Zeit) */
export function fromDateTimeInput(date, time) {
  const [y, mo, d] = date.split('-').map(Number);
  const [h, mi] = time.split(':').map(Number);
  return new Date(y, mo - 1, d, h, mi).getTime();
}

/** Aktive (nicht gelöschte) Einträge im Zeitraum [from, to), zugeordnet über die Startzeit. */
export function entriesInRange(entries, from, to) {
  return entries
    .filter((e) => !e.deleted && e.start >= from && e.start < to)
    .sort((a, b) => a.start - b.start);
}

/**
 * Auswertung eines Zeitraums.
 * @returns {{from, to, total, count, running, byCustomer: Array<{id, name, ms, count}>, entries}}
 */
export function buildReport({ entries, customers, from, to, now = Date.now() }) {
  const names = new Map(customers.map((c) => [c.id, c.name]));
  const list = entriesInRange(entries, from, to);
  const byId = new Map();
  let total = 0;
  let running = 0;
  for (const e of list) {
    const ms = entryDuration(e, now);
    if (e.end == null) running++;
    total += ms;
    let row = byId.get(e.customer_id);
    if (!row) {
      row = { id: e.customer_id, name: names.get(e.customer_id) ?? '(unbekannter Kunde)', ms: 0, count: 0 };
      byId.set(e.customer_id, row);
    }
    row.ms += ms;
    row.count++;
  }
  const byCustomer = [...byId.values()].sort((a, b) => b.ms - a.ms || a.name.localeCompare(b.name, 'de'));
  return { from, to, total, count: list.length, running, byCustomer, entries: list };
}

function csvCell(value) {
  const s = String(value ?? '');
  // Formel-Injektion in Tabellenkalkulationen verhindern
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[";\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** CSV (Semikolon-getrennt, für deutsches Excel) mit allen Einträgen eines Reports. */
export function reportToCSV(report, customers, now = Date.now()) {
  const names = new Map(customers.map((c) => [c.id, c.name]));
  const rows = [['Datum', 'Kunde', 'Start', 'Ende', 'Dauer (h:mm)', 'Stunden', 'Notiz']];
  for (const e of report.entries) {
    const ms = entryDuration(e, now);
    rows.push([
      formatDate(e.start),
      names.get(e.customer_id) ?? '',
      formatTime(e.start),
      e.end == null ? 'läuft' : formatTime(e.end),
      formatDuration(ms),
      formatHours(ms),
      e.note ?? '',
    ]);
  }
  rows.push([]);
  rows.push(['Summe je Kunde']);
  for (const c of report.byCustomer) rows.push(['', c.name, '', '', formatDuration(c.ms), formatHours(c.ms), '']);
  rows.push(['', 'Gesamt', '', '', formatDuration(report.total), formatHours(report.total), '']);
  return '﻿' + rows.map((r) => r.map(csvCell).join(';')).join('\r\n') + '\r\n';
}
