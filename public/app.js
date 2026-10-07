import { store, api } from './store.js';
import {
  buildReport, reportToCSV, monthRange, monthLabel, entryDuration, entriesInRange,
  formatDuration, formatClock, formatHours, formatDate, formatTime, formatDateTime,
  toDateInput, toTimeInput, fromDateTimeInput, WEEKDAYS,
} from './shared/core.js';

// Bei jeder Änderung an der Web-App erhöhen (gleicher Wert wie RELEASE in sw.js)
const APP_VERSION = '1.1.1';

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const DAY = 24 * 3600 * 1000;

const ui = {
  tab: 'entries',
  year: new Date().getFullYear(),
  month: new Date().getMonth(),
  filterCustomer: '',
  showArchived: false,
  settings: null,
};

// ---------------------------------------------------------------- Toast
let toastTimer;
function toast(message, { action, onAction, duration = 4000 } = {}) {
  const el = $('#toast');
  el.innerHTML = `<span>${esc(message)}</span>${action ? `<button type="button">${esc(action)}</button>` : ''}`;
  el.hidden = false;
  if (action) $('button', el).onclick = () => { el.hidden = true; onAction(); };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, duration);
}

// ---------------------------------------------------------------- Prompt-Dialog
function promptDialog({ title, text = '', value = '', ok = 'OK', type = 'text' }) {
  const dlg = $('#prompt-dialog');
  $('#prompt-title').textContent = title;
  $('#prompt-text').textContent = text;
  $('#prompt-text').hidden = !text;
  const input = $('#prompt-input');
  input.type = type;
  input.value = value;
  input.hidden = type === 'none';
  $('#prompt-ok').textContent = ok;
  dlg.showModal();
  if (type !== 'none') input.select();
  return new Promise((resolve) => {
    $('#prompt-form').onsubmit = (ev) => { ev.preventDefault(); dlg.close(); resolve(type === 'none' ? true : input.value); };
    $('#prompt-cancel').onclick = () => { dlg.close(); resolve(null); };
    dlg.oncancel = () => resolve(null);
  });
}

const confirmDialog = (title, text, ok = 'OK') => promptDialog({ title, text, ok, type: 'none' });

// ---------------------------------------------------------------- Timer
function customerOptions(selectedId, { includeArchivedId } = {}) {
  const list = store.recentCustomers();
  const extra = includeArchivedId && !list.some((c) => c.id === includeArchivedId) ? store.customer(includeArchivedId) : null;
  return [...list, ...(extra ? [extra] : [])]
    .map((c) => `<option value="${esc(c.id)}"${c.id === selectedId ? ' selected' : ''}>${esc(c.name)}${c.archived ? ' (archiviert)' : ''}</option>`)
    .join('');
}

let lastTimerKey = '';
function renderTimer() {
  const el = $('#timer');
  const running = store.running;
  const key = running ? `run:${running.id}:${running.start}:${running.customer_id}` : `idle:${store.customers.map((c) => c.id + c.name + c.archived).join()}`;
  // Nur neu aufbauen, wenn sich die Struktur geändert hat (sonst gehen Eingaben verloren)
  if (key !== lastTimerKey) {
    lastTimerKey = key;
    if (running) {
      const c = store.customer(running.customer_id);
      el.className = 'card timer running';
      el.innerHTML = `
        <div class="timer-head">
          <span class="dot"></span>
          <strong class="timer-customer">${esc(c?.name ?? 'Unbekannter Kunde')}</strong>
        </div>
        <div class="clock" id="clock">${formatClock(entryDuration(running))}</div>
        <div class="since">seit ${esc(formatDateTime(running.start))}</div>
        <input type="text" id="running-note" class="note" placeholder="Notiz (optional)" maxlength="2000" value="${esc(running.note)}">
        <div class="timer-actions">
          <button type="button" class="ghost" data-action="edit-running">Bearbeiten</button>
          <button type="button" class="stop big" data-action="stop">■ Stopp</button>
        </div>`;
    } else {
      const recent = store.recentCustomers();
      el.className = 'card timer';
      if (!recent.length) {
        el.innerHTML = `<p class="empty">Lege zuerst einen Kunden an, um die Zeiterfassung zu starten.</p>
          <button type="button" class="primary big" data-action="goto-customers">Kunden anlegen</button>`;
      } else {
        el.innerHTML = `
          <div class="quick">${recent.slice(0, 4).map((c) => `<button type="button" class="chip" data-action="quick-start" data-id="${esc(c.id)}">▶ ${esc(c.name)}</button>`).join('')}</div>
          <div class="start-row">
            <select id="start-customer" aria-label="Kunde">${customerOptions(recent[0].id)}</select>
            <button type="button" class="primary big" data-action="start">▶ Start</button>
          </div>
          <input type="text" id="start-note" class="note" placeholder="Notiz (optional)" maxlength="2000">`;
      }
    }
  } else if (running) {
    // Notiz aktualisieren, falls sie anderswo geändert wurde (Sync) – aber nie während der Eingabe
    const input = $('#running-note');
    if (input && document.activeElement !== input && !pendingNote && input.value !== running.note) input.value = running.note;
  }
  tick();
}

function tick() {
  const running = store.running;
  if (running) {
    const clock = $('#clock');
    const ms = entryDuration(running);
    if (clock) clock.textContent = formatClock(ms);
    document.title = `${formatDuration(ms)} · ${store.customer(running.customer_id)?.name ?? ''} – Zeiterfassung`;
  } else {
    document.title = 'Zeiterfassung';
  }
}

// ---------------------------------------------------------------- Monatsnavigation
function monthNav() {
  const now = new Date();
  const isCurrent = ui.year === now.getFullYear() && ui.month === now.getMonth();
  return `<div class="month-nav">
    <button type="button" class="ghost icon" data-action="month" data-delta="-1" aria-label="Vorheriger Monat">‹</button>
    <strong>${monthLabel(ui.year, ui.month)}</strong>
    <button type="button" class="ghost icon" data-action="month" data-delta="1" aria-label="Nächster Monat">›</button>
    ${isCurrent ? '' : '<button type="button" class="ghost small" data-action="month-today">Heute</button>'}
  </div>`;
}

// ---------------------------------------------------------------- Einträge
function renderEntries() {
  const [from, to] = monthRange(ui.year, ui.month);
  let list = entriesInRange(store.entries, from, to);
  if (ui.filterCustomer) list = list.filter((e) => e.customer_id === ui.filterCustomer);
  list.reverse();

  const days = new Map();
  for (const e of list) {
    const key = toDateInput(e.start);
    if (!days.has(key)) days.set(key, []);
    days.get(key).push(e);
  }
  const total = list.reduce((s, e) => s + entryDuration(e), 0);
  const filterName = ui.filterCustomer ? store.customer(ui.filterCustomer)?.name : '';

  return `
    <div class="view-head">
      ${monthNav()}
      <button type="button" class="primary" data-action="new-entry">+ Zeit nachtragen</button>
    </div>
    <div class="filter-row">
      <select data-action="filter" aria-label="Kunde filtern">
        <option value="">Alle Kunden</option>
        ${store.customers.map((c) => `<option value="${esc(c.id)}"${c.id === ui.filterCustomer ? ' selected' : ''}>${esc(c.name)}</option>`).join('')}
      </select>
      <span class="sum">${list.length} ${list.length === 1 ? 'Eintrag' : 'Einträge'} · <strong>${formatDuration(total)} h</strong></span>
    </div>
    ${list.length ? [...days].map(([day, items]) => {
      const d = new Date(items[0].start);
      const daySum = items.reduce((s, e) => s + entryDuration(e), 0);
      return `<div class="day">
        <div class="day-head"><span>${WEEKDAYS[d.getDay()]} ${formatDate(d.getTime())}</span><span>${formatDuration(daySum)} h</span></div>
        ${items.map((e) => `
          <button type="button" class="entry${e.end == null ? ' is-running' : ''}" data-action="edit-entry" data-id="${esc(e.id)}">
            <span class="entry-time">${formatTime(e.start)}–${e.end == null ? 'läuft' : formatTime(e.end)}${e.end != null && toDateInput(e.end) !== day ? ' (+1)' : ''}</span>
            <span class="entry-main"><strong>${esc(store.customer(e.customer_id)?.name ?? '?')}</strong>${e.note ? `<span class="entry-note">${esc(e.note)}</span>` : ''}</span>
            <span class="entry-dur">${formatDuration(entryDuration(e))}</span>
          </button>`).join('')}
      </div>`;
    }).join('') : `<p class="empty">Keine Einträge${filterName ? ` für ${esc(filterName)}` : ''} in diesem Monat.</p>`}`;
}

// ---------------------------------------------------------------- Auswertung
function currentReport() {
  const [from, to] = monthRange(ui.year, ui.month);
  return buildReport({ entries: store.entries, customers: Object.values(store.state.customers), from, to });
}

function renderReport() {
  const r = currentReport();
  const max = Math.max(1, ...r.byCustomer.map((c) => c.ms));
  const [pFrom, pTo] = monthRange(ui.year, ui.month - 1);
  const prev = buildReport({ entries: store.entries, customers: [], from: pFrom, to: pTo });
  const workDays = new Set(r.entries.map((e) => toDateInput(e.start))).size;
  return `
    <div class="view-head">${monthNav()}</div>
    <div class="stats">
      <div class="stat"><span class="stat-label">Gesamt</span><span class="stat-value">${formatDuration(r.total)} h</span><span class="stat-sub">${formatHours(r.total)} Std.</span></div>
      <div class="stat"><span class="stat-label">Tage mit Einträgen</span><span class="stat-value">${workDays}</span><span class="stat-sub">${r.count} Einträge</span></div>
      <div class="stat"><span class="stat-label">Vormonat</span><span class="stat-value">${formatDuration(prev.total)} h</span><span class="stat-sub">${monthLabel(new Date(pFrom).getFullYear(), new Date(pFrom).getMonth())}</span></div>
    </div>
    ${r.running ? '<p class="hint">Ein laufender Timer ist bis jetzt mitgezählt.</p>' : ''}
    <div class="card">
      ${r.byCustomer.length ? `<table class="report">
        <thead><tr><th>Kunde</th><th class="num">h:mm</th><th class="num">Std.</th></tr></thead>
        <tbody>${r.byCustomer.map((c) => `
          <tr data-action="report-customer" data-id="${esc(c.id)}">
            <td><div class="bar-label">${esc(c.name)} <span class="muted">· ${c.count}</span></div><div class="bar"><span data-w="${(c.ms / max * 100).toFixed(1)}"></span></div></td>
            <td class="num">${formatDuration(c.ms)}</td>
            <td class="num">${formatHours(c.ms)}</td>
          </tr>`).join('')}
        </tbody>
        <tfoot><tr><td>Gesamt</td><td class="num">${formatDuration(r.total)}</td><td class="num">${formatHours(r.total)}</td></tr></tfoot>
      </table>` : '<p class="empty">Keine Einträge in diesem Monat.</p>'}
    </div>
    <div class="button-row">
      <button type="button" data-action="csv"${r.count ? '' : ' disabled'}>CSV herunterladen</button>
      <button type="button" data-action="mail-report">Per E-Mail senden</button>
    </div>`;
}

// ---------------------------------------------------------------- Kunden
function renderCustomers() {
  const [from, to] = monthRange(new Date().getFullYear(), new Date().getMonth());
  const r = buildReport({ entries: store.entries, customers: [], from, to });
  const msBy = new Map(r.byCustomer.map((c) => [c.id, c.ms]));
  const active = store.customers.filter((c) => !c.archived);
  const archived = store.customers.filter((c) => c.archived);
  const row = (c) => `
    <li class="customer">
      <span class="customer-name">${esc(c.name)}</span>
      <span class="muted">${msBy.has(c.id) ? `${formatDuration(msBy.get(c.id))} h` : ''}</span>
      <span class="customer-actions">
        <button type="button" class="ghost small" data-action="rename-customer" data-id="${esc(c.id)}">Umbenennen</button>
        <button type="button" class="ghost small" data-action="archive-customer" data-id="${esc(c.id)}">${c.archived ? 'Reaktivieren' : 'Archivieren'}</button>
        <button type="button" class="ghost small danger" data-action="delete-customer" data-id="${esc(c.id)}" aria-label="Löschen">✕</button>
      </span>
    </li>`;
  return `
    <form class="add-customer card" id="add-customer">
      <input type="text" name="name" placeholder="Neuer Kunde" maxlength="200" required autocomplete="off">
      <button type="submit" class="primary">Hinzufügen</button>
    </form>
    ${active.length ? `<p class="muted small-text">Stunden im aktuellen Monat</p><ul class="customers card">${active.map(row).join('')}</ul>` : '<p class="empty">Noch keine Kunden angelegt.</p>'}
    ${archived.length ? `<button type="button" class="ghost" data-action="toggle-archived">${ui.showArchived ? '▾' : '▸'} Archiviert (${archived.length})</button>
      ${ui.showArchived ? `<ul class="customers card archived">${archived.map(row).join('')}</ul>` : ''}` : ''}`;
}

// ---------------------------------------------------------------- Einstellungen
function renderSettings() {
  const s = ui.settings;
  const lastSync = store.state.lastSync ? formatDateTime(store.state.lastSync) : 'noch nie';
  return `
    <div class="card settings">
      <h3>E-Mail</h3>
      ${!s ? '<p class="hint">Einstellungen werden geladen … (nur online verfügbar)</p>' : `
        ${s.mailConfigured ? `<p class="hint">Mails gehen an <strong>${esc(s.mailTo)}</strong>.</p>` : '<p class="warn">E-Mail ist auf dem Server noch nicht eingerichtet (SMTP-Einstellungen in der .env).</p>'}
        <label class="setting">Erinnerung, wenn ein Timer länger läuft als
          <span class="inline"><input type="number" min="0" max="48" step="0.5" name="reminderHours" value="${s.reminderHours}" data-setting> Stunden</span>
          <small>0 = keine Erinnerung</small>
        </label>
        <label class="check"><input type="checkbox" name="monthlyReport" data-setting${s.monthlyReport ? ' checked' : ''}> Monatsbericht am 1. des Folgemonats (ab ${s.reportHour} Uhr)</label>
        <label class="check"><input type="checkbox" name="weeklyReport" data-setting${s.weeklyReport ? ' checked' : ''}> Wochenbericht jeden Montag</label>`}
    </div>
    <div class="card settings">
      <h3>Anmeldung</h3>
      <div class="button-row">
        <button type="button" data-action="change-password">Passwort ändern</button>
        <button type="button" data-action="logout">Abmelden</button>
        <button type="button" class="danger" data-action="logout-all">Alle Geräte abmelden</button>
      </div>
    </div>
    <div class="card settings">
      <h3>Daten</h3>
      <p class="hint">Letzte Synchronisation: ${esc(lastSync)}${store.pendingCount ? ` · ${store.pendingCount} Änderung(en) noch nicht übertragen` : ''}</p>
      ${store.status === 'error' ? `<p class="warn">Sync-Fehler: ${esc(store.lastError ?? 'unbekannt')}</p>` : ''}
      <div class="button-row">
        <button type="button" data-action="export-all">Alle Einträge als CSV</button>
        <button type="button" data-action="resync">Neu vom Server laden</button>
      </div>
    </div>
    <p class="muted small-text">Version ${APP_VERSION}</p>`;
}

async function loadSettings() {
  try {
    ui.settings = await api('api/settings');
    if (ui.tab === 'settings') renderView();
  } catch { /* offline */ }
}

// ---------------------------------------------------------------- View-Steuerung
function renderView() {
  const view = $('#view');
  const focused = document.activeElement?.closest('#view') ? document.activeElement : null;
  if (focused && (focused.matches('input[type=text], input[type=number], textarea'))) return; // nicht beim Tippen neu aufbauen
  const scroll = window.scrollY;
  view.innerHTML = { entries: renderEntries, report: renderReport, customers: renderCustomers, settings: renderSettings }[ui.tab]();
  for (const bar of view.querySelectorAll('[data-w]')) bar.style.width = `${bar.dataset.w}%`;
  window.scrollTo(0, scroll);
  for (const b of document.querySelectorAll('#tabs button')) b.classList.toggle('active', b.dataset.tab === ui.tab);
}

function render() {
  renderTimer();
  renderView();
}

function setTab(tab) {
  ui.tab = tab;
  try { localStorage.setItem('tt-tab', tab); } catch { /* egal */ }
  if (tab === 'settings') loadSettings();
  renderView();
  window.scrollTo(0, 0);
}

function renderSyncStatus() {
  const el = $('#sync-status');
  const pending = store.pendingCount;
  const map = {
    idle: pending ? ['pending', `${pending} ausstehend`] : ['ok', 'Synchron'],
    syncing: ['busy', 'Synchronisiere …'],
    offline: ['offline', pending ? `Offline · ${pending} ausstehend` : 'Offline'],
    error: ['error', 'Sync-Fehler'],
    auth: ['error', 'Abgemeldet'],
  };
  const [cls, label] = map[store.status] ?? map.idle;
  el.className = `sync ${cls}`;
  el.textContent = label;
  el.title = store.status === 'error' ? store.lastError ?? '' : 'Jetzt synchronisieren';
  $('#login').hidden = store.status !== 'auth';
  if (store.status === 'auth') setTimeout(() => $('#login-form [name=password]').focus(), 50);
}

// ---------------------------------------------------------------- Eintrags-Dialog
const dlg = () => $('#entry-dialog');
let editing = null;

function parseDuration(text) {
  const t = text.trim().replace(',', '.');
  if (!t) return null;
  if (t.includes(':')) {
    const [h, m] = t.split(':').map(Number);
    return Number.isFinite(h) && Number.isFinite(m) ? (h * 60 + m) * 60000 : NaN;
  }
  const h = Number(t);
  return Number.isFinite(h) ? Math.round(h * 60) * 60000 : NaN;
}

/** Start/Ende aus den Formularfeldern; Ende vor Start = nächster Tag. */
function formTimes(f) {
  if (!f.date.value || !f.start.value) return null;
  const start = fromDateTimeInput(f.date.value, f.start.value);
  if (f.running.checked) return { start, end: null };
  if (!f.end.value) return { start, end: undefined };
  let end = fromDateTimeInput(f.date.value, f.end.value);
  if (end < start) end += DAY;
  return { start, end };
}

function updateDialogHint() {
  const f = $('#entry-form');
  const t = formTimes(f);
  const hint = $('#entry-hint');
  f.end.disabled = f.duration.disabled = f.running.checked;
  updateRoundButtons(t);
  if (!t || t.end === undefined) { hint.textContent = ''; return; }
  if (t.end === null) { hint.textContent = `Läuft seit ${formatDuration(Date.now() - t.start)} h`; return; }
  hint.textContent = toDateInput(t.end) !== toDateInput(t.start) ? `Endet am nächsten Tag (${formatDate(t.end)})` : '';
  if (document.activeElement !== f.duration) f.duration.value = formatDuration(t.end - t.start);
}

// −/+ neben der Dauer: springt zur nächsten halben bzw. vollen Stunde (0:23 → 0:30 → 1:00 → 1:30 …).
// Die Startzeit bleibt, das Ende wird angepasst.
const HALF_HOUR = 30 * 60 * 1000;
function roundedDurations(t) {
  const ms = t.end - t.start;
  return {
    down: Math.ceil(ms / HALF_HOUR) * HALF_HOUR - HALF_HOUR,
    up: Math.floor(ms / HALF_HOUR) * HALF_HOUR + HALF_HOUR,
  };
}

function updateRoundButtons(t) {
  const active = Boolean(t && t.end != null);
  const { down, up } = active ? roundedDurations(t) : {};
  $('#round-down').disabled = !active || down <= 0;
  $('#round-up').disabled = !active || up >= DAY;
}

function roundDialogDuration(direction) {
  const f = $('#entry-form');
  const t = formTimes(f);
  if (!t || t.end == null) return;
  const target = roundedDurations(t)[direction];
  f.end.value = toTimeInput(t.start + target);
  f.duration.value = formatDuration(target);
  updateDialogHint();
}

function openEntryDialog(entry) {
  const f = $('#entry-form');
  editing = entry?.id ?? null;
  const now = Date.now();
  const isRunning = entry && entry.end == null;
  $('#entry-title').textContent = entry ? (isRunning ? 'Laufenden Timer bearbeiten' : 'Eintrag bearbeiten') : 'Zeit nachtragen';
  f.customer_id.innerHTML = customerOptions(entry?.customer_id ?? store.recentCustomers()[0]?.id, { includeArchivedId: entry?.customer_id });
  const start = entry?.start ?? now - 3600000;
  f.date.value = toDateInput(start);
  f.start.value = toTimeInput(start);
  f.end.value = entry ? (entry.end != null ? toTimeInput(entry.end) : '') : toTimeInput(now);
  f.duration.value = '';
  f.running.checked = Boolean(isRunning);
  $('#running-wrap').hidden = !isRunning;
  f.note.value = entry?.note ?? '';
  $('#entry-error').textContent = '';
  $('#entry-delete').hidden = !entry;
  updateDialogHint();
  dlg().showModal();
}

function saveEntryDialog() {
  const f = $('#entry-form');
  const err = $('#entry-error');
  if (!f.customer_id.value) { err.textContent = 'Bitte einen Kunden wählen.'; return false; }
  const t = formTimes(f);
  if (!t) { err.textContent = 'Bitte Datum und Startzeit angeben.'; return false; }
  if (t.end === undefined) { err.textContent = 'Bitte Endzeit oder Dauer angeben.'; return false; }
  if (t.end === null && t.start > Date.now()) { err.textContent = 'Ein laufender Timer kann nicht in der Zukunft starten.'; return false; }
  if (t.end !== null && t.end - t.start > DAY) { err.textContent = 'Ein Eintrag darf höchstens 24 Stunden dauern.'; return false; }
  store.saveEntry({ id: editing ?? undefined, customer_id: f.customer_id.value, start: t.start, end: t.end, note: f.note.value.trim() });
  toast(editing ? 'Eintrag gespeichert' : 'Zeit eingetragen');
  return true;
}

function deleteEntry(id) {
  store.deleteEntry(id);
  toast('Eintrag gelöscht', { action: 'Rückgängig', onAction: () => store.restoreEntry(id), duration: 6000 });
}

// ---------------------------------------------------------------- Download
function download(filename, content, type = 'text/csv;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------------------------------------------------------------- Aktionen
const actions = {
  'goto-customers': () => setTab('customers'),
  'quick-start': (el) => { store.start(el.dataset.id, $('#start-note')?.value.trim() ?? ''); },
  start: () => {
    const id = $('#start-customer')?.value;
    if (id) store.start(id, $('#start-note')?.value.trim() ?? '');
  },
  stop: () => {
    flushNote();
    const e = store.stop();
    if (e) toast(`Gestoppt: ${formatDuration(e.end - e.start)} h für ${store.customer(e.customer_id)?.name ?? ''}`, {
      action: 'Weiterlaufen', onAction: () => store.saveEntry({ id: e.id, end: null }), duration: 6000,
    });
  },
  'edit-running': () => store.running && openEntryDialog(store.running),
  'edit-entry': (el) => openEntryDialog(store.state.entries[el.dataset.id]),
  'new-entry': () => {
    if (!store.recentCustomers().length) { toast('Bitte zuerst einen Kunden anlegen.'); setTab('customers'); return; }
    openEntryDialog(null);
  },
  month: (el) => {
    const d = new Date(ui.year, ui.month + Number(el.dataset.delta), 1);
    ui.year = d.getFullYear();
    ui.month = d.getMonth();
    renderView();
  },
  'month-today': () => {
    ui.year = new Date().getFullYear();
    ui.month = new Date().getMonth();
    renderView();
  },
  'report-customer': (el) => { ui.filterCustomer = el.dataset.id; setTab('entries'); },
  csv: () => {
    const r = currentReport();
    download(`zeiterfassung_${ui.year}-${String(ui.month + 1).padStart(2, '0')}.csv`, reportToCSV(r, Object.values(store.state.customers)));
  },
  'mail-report': async () => {
    try {
      await api('api/report/send', { method: 'POST', body: { year: ui.year, month: ui.month } });
      toast(`Bericht für ${monthLabel(ui.year, ui.month)} gesendet`);
    } catch (err) {
      toast(navigator.onLine ? err.message : 'Offline – Mailversand nicht möglich.');
    }
  },
  'rename-customer': async (el) => {
    const c = store.customer(el.dataset.id);
    const name = (await promptDialog({ title: 'Kunde umbenennen', value: c.name, ok: 'Speichern' }))?.trim();
    if (name && name !== c.name) store.saveCustomer({ id: c.id, name });
  },
  'archive-customer': (el) => {
    const c = store.customer(el.dataset.id);
    store.saveCustomer({ id: c.id, archived: !c.archived });
    toast(c.archived ? `${c.name} reaktiviert` : `${c.name} archiviert – erscheint nicht mehr in der Auswahl`);
  },
  'delete-customer': async (el) => {
    const c = store.customer(el.dataset.id);
    const count = store.entries.filter((e) => e.customer_id === c.id).length;
    if (count) {
      if (await confirmDialog('Kunde hat Einträge', `${c.name} hat ${count} Einträge und kann daher nicht gelöscht werden. Stattdessen archivieren?`, 'Archivieren')) {
        store.saveCustomer({ id: c.id, archived: true });
      }
      return;
    }
    if (await confirmDialog('Kunde löschen?', `${c.name} wird endgültig gelöscht.`, 'Löschen')) store.deleteCustomer(c.id);
  },
  'toggle-archived': () => { ui.showArchived = !ui.showArchived; renderView(); },
  'change-password': async () => {
    const current = await promptDialog({ title: 'Passwort ändern', text: 'Aktuelles Passwort', type: 'password', ok: 'Weiter' });
    if (current == null) return;
    const next = await promptDialog({ title: 'Passwort ändern', text: 'Neues Passwort (mind. 8 Zeichen). Andere Geräte werden abgemeldet.', type: 'password', ok: 'Ändern' });
    if (next == null) return;
    try {
      await api('api/password', { method: 'POST', body: { current, next } });
      toast('Passwort geändert');
    } catch (err) { toast(err.message); }
  },
  logout: async () => {
    if (await confirmDialog('Abmelden?', store.pendingCount ? 'Achtung: Es gibt noch nicht übertragene Änderungen. Sie bleiben auf diesem Gerät gespeichert.' : 'Du kannst dich jederzeit wieder anmelden.', 'Abmelden')) store.logout();
  },
  'logout-all': async () => {
    if (await confirmDialog('Alle Geräte abmelden?', 'Alle Geräte (auch dieses) müssen sich danach neu anmelden.', 'Alle abmelden')) store.logout(true);
  },
  'export-all': () => {
    const r = buildReport({ entries: store.entries, customers: Object.values(store.state.customers), from: 0, to: Number.MAX_SAFE_INTEGER });
    download(`zeiterfassung_alle_${toDateInput(Date.now())}.csv`, reportToCSV(r, Object.values(store.state.customers)));
  },
  resync: async () => {
    await store.resync();
    toast(store.status === 'idle' ? 'Daten neu geladen' : 'Laden fehlgeschlagen – offline?');
  },
};

document.addEventListener('click', (ev) => {
  const el = ev.target.closest('[data-action]');
  if (!el || el.tagName === 'SELECT') return;
  const fn = actions[el.dataset.action];
  if (fn) { ev.preventDefault(); fn(el); }
});

$('#tabs').addEventListener('click', (ev) => {
  const b = ev.target.closest('[data-tab]');
  if (b) setTab(b.dataset.tab);
});

$('#sync-status').addEventListener('click', () => {
  if (store.status === 'error') toast(`Sync-Fehler: ${store.lastError ?? 'unbekannt'}`, { duration: 8000 });
  store.sync();
});

$('#view').addEventListener('change', async (ev) => {
  const el = ev.target;
  if (el.dataset.action === 'filter') { ui.filterCustomer = el.value; renderView(); return; }
  if (el.hasAttribute('data-setting')) {
    const value = el.type === 'checkbox' ? el.checked : Number(el.value);
    try {
      ui.settings = { ...ui.settings, ...(await api('api/settings', { method: 'PUT', body: { [el.name]: value } })) };
      toast('Gespeichert');
    } catch (err) {
      toast(navigator.onLine ? err.message : 'Offline – Einstellungen können nur online geändert werden.');
      el.blur();
      renderView();
    }
  }
});

$('#view').addEventListener('submit', (ev) => {
  if (ev.target.id !== 'add-customer') return;
  ev.preventDefault();
  const input = ev.target.name;
  const name = input.value.trim();
  if (!name) return;
  if (store.customers.some((c) => c.name.toLowerCase() === name.toLowerCase())) { toast('Diesen Kunden gibt es schon.'); return; }
  store.saveCustomer({ name });
  input.value = '';
  input.blur();
  renderView();
  toast(`${name} angelegt`);
});

// Notiz des laufenden Timers speichern: verzögert beim Tippen, sofort beim Verlassen des Feldes,
// beim Stoppen und wenn die App in den Hintergrund geht (iOS beendet Hintergrund-Apps ohne Vorwarnung)
let noteTimer;
let pendingNote = null; // { id, value }
function flushNote() {
  clearTimeout(noteTimer);
  if (!pendingNote) return;
  const { id, value } = pendingNote;
  pendingNote = null;
  const entry = store.state.entries[id];
  if (entry && entry.note !== value) store.saveEntry({ id, note: value });
}
$('#timer').addEventListener('input', (ev) => {
  if (ev.target.id !== 'running-note') return;
  const id = store.running?.id;
  if (!id) return;
  pendingNote = { id, value: ev.target.value.trim() };
  clearTimeout(noteTimer);
  noteTimer = setTimeout(flushNote, 600);
});
$('#timer').addEventListener('focusout', (ev) => {
  if (ev.target.id === 'running-note') flushNote();
});
$('#timer').addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' && ev.target.id === 'start-note') actions.start();
  if (ev.key === 'Enter' && ev.target.id === 'running-note') ev.target.blur();
});

// Dialog
const entryForm = $('#entry-form');
entryForm.addEventListener('input', (ev) => {
  const f = entryForm;
  if (ev.target === f.duration) {
    const ms = parseDuration(f.duration.value);
    if (ms != null && !Number.isNaN(ms) && f.date.value && f.start.value) {
      f.end.value = toTimeInput(fromDateTimeInput(f.date.value, f.start.value) + ms);
    }
  }
  updateDialogHint();
});
entryForm.addEventListener('submit', (ev) => {
  ev.preventDefault();
  if (saveEntryDialog()) dlg().close();
});
$('#entry-cancel').addEventListener('click', () => dlg().close());
$('#round-down').addEventListener('click', () => roundDialogDuration('down'));
$('#round-up').addEventListener('click', () => roundDialogDuration('up'));
$('#entry-delete').addEventListener('click', () => {
  const id = editing;
  dlg().close();
  if (id) deleteEntry(id);
});

// Login
$('#login-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const f = ev.target;
  $('#login-error').textContent = '';
  try {
    await store.login(f.password.value);
    f.password.value = '';
    loadSettings();
  } catch (err) {
    $('#login-error').textContent = navigator.onLine ? err.message : 'Offline – Anmeldung nicht möglich.';
  }
});

// ---------------------------------------------------------------- Start
store.addEventListener('change', () => { render(); renderSyncStatus(); });
store.addEventListener('status', renderSyncStatus);

try { ui.tab = localStorage.getItem('tt-tab') || 'entries'; } catch { /* egal */ }
if (!['entries', 'report', 'customers', 'settings'].includes(ui.tab)) ui.tab = 'entries';

await store.load();
render();
renderSyncStatus();
store.sync().then(() => { if (ui.tab === 'settings') loadSettings(); });

setInterval(tick, 1000);
// Laufende Dauer in Listen/Auswertung minütlich aktualisieren, regelmäßig synchronisieren
setInterval(() => { if (store.running) renderView(); }, 60000);
setInterval(() => store.sync(), 2 * 60000);
window.addEventListener('online', () => store.sync());
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') { store.sync(); render(); return; }
  flushNote();
  store.flush();
  store.sync();
});
window.addEventListener('pagehide', () => { flushNote(); store.flush(); });

if ('serviceWorker' in navigator) {
  const hadController = Boolean(navigator.serviceWorker.controller);
  // updateViaCache: 'none' – sw.js nie aus dem HTTP-Cache, damit neue Versionen sofort erkannt werden
  const registration = navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(() => null);
  // Installierte Apps bleiben oft tagelang offen: beim Zurückkehren nach Updates suchen
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'visible') (await registration)?.update().catch(() => {});
  });
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController) toast('Neue Version verfügbar', { action: 'Neu laden', onAction: () => location.reload(), duration: 15000 });
  });
}
