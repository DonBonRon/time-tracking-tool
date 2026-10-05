// Lokaler Datenbestand + Synchronisation mit dem Server.
// Alle Änderungen werden sofort lokal gespeichert (IndexedDB) und in einer
// Warteschlange gesammelt; sobald Netz da ist, wird synchronisiert.

const DB_NAME = 'timetrack';
const STATE_KEY = 'state';

// ---- Minimaler Key/Value-Speicher auf IndexedDB (Fallback: localStorage) ----
let dbPromise;
function idb() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore('kv');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function kvGet(key) {
  try {
    const db = await idb();
    return await new Promise((resolve, reject) => {
      const req = db.transaction('kv').objectStore('kv').get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } catch {
    try { return JSON.parse(localStorage.getItem(`${DB_NAME}:${key}`)); } catch { return undefined; }
  }
}

async function kvSet(key, value) {
  try {
    const db = await idb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put(value, key);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    try { localStorage.setItem(`${DB_NAME}:${key}`, JSON.stringify(value)); } catch { /* Speicher nicht verfügbar */ }
  }
}

const emptyState = () => ({
  rev: 0,
  customers: {},
  entries: {},
  pending: { customers: {}, entries: {} },
  clockOffset: 0,
  lastSync: 0,
});

export function newId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

class Store extends EventTarget {
  state = emptyState();
  status = 'idle'; // idle | syncing | offline | auth | error
  #syncing = null;
  #syncTimer = null;
  #saveTimer = null;

  async load() {
    const saved = await kvGet(STATE_KEY);
    if (saved && typeof saved === 'object') this.state = { ...emptyState(), ...saved };
    this.#emit();
  }

  #emit() {
    this.dispatchEvent(new Event('change'));
  }

  #setStatus(status) {
    if (this.status !== status) {
      this.status = status;
      this.dispatchEvent(new Event('status'));
    }
  }

  #persist() {
    clearTimeout(this.#saveTimer);
    this.#saveTimer = setTimeout(() => kvSet(STATE_KEY, this.state), 50);
  }

  /** Sofort lokal speichern, z. B. bevor die App in den Hintergrund geht. */
  flush() {
    clearTimeout(this.#saveTimer);
    return kvSet(STATE_KEY, this.state);
  }

  /** Zeitstempel für Änderungen – an die Serveruhr angeglichen, damit zwei Geräte vergleichbar sind. */
  #stamp(prev) {
    const t = Date.now() + (this.state.clockOffset || 0);
    return prev && prev.updated_at >= t ? prev.updated_at + 1 : t;
  }

  // ---- Lesen ----
  get customers() {
    return Object.values(this.state.customers).filter((c) => !c.deleted)
      .sort((a, b) => a.name.localeCompare(b.name, 'de'));
  }

  get entries() {
    return Object.values(this.state.entries).filter((e) => !e.deleted);
  }

  get running() {
    return this.entries.filter((e) => e.end == null).sort((a, b) => b.start - a.start)[0] ?? null;
  }

  customer(id) {
    return this.state.customers[id];
  }

  get pendingCount() {
    return Object.keys(this.state.pending.customers).length + Object.keys(this.state.pending.entries).length;
  }

  /** Aktive Kunden, zuletzt genutzte zuerst. */
  recentCustomers() {
    const last = new Map();
    for (const e of this.entries) if ((last.get(e.customer_id) ?? 0) < e.start) last.set(e.customer_id, e.start);
    return this.customers.filter((c) => !c.archived)
      .sort((a, b) => (last.get(b.id) ?? 0) - (last.get(a.id) ?? 0) || a.name.localeCompare(b.name, 'de'));
  }

  // ---- Schreiben ----
  #put(kind, record) {
    const prev = this.state[kind][record.id];
    const rec = { ...prev, ...record, updated_at: this.#stamp(prev) };
    this.state[kind][rec.id] = rec;
    this.state.pending[kind][rec.id] = rec;
    this.#persist();
    this.#emit();
    this.scheduleSync(300);
    return rec;
  }

  // Standardwerte nur für neue Datensätze – bei Änderungen bleiben alle nicht übergebenen Felder erhalten
  saveCustomer(data) {
    const id = data.id ?? newId();
    const defaults = this.state.customers[id] ? {} : { archived: false, deleted: false };
    return this.#put('customers', { ...defaults, ...data, id });
  }

  saveEntry(data) {
    const id = data.id ?? newId();
    const defaults = this.state.entries[id] ? {} : { note: '', end: null, deleted: false };
    return this.#put('entries', { ...defaults, ...data, id });
  }

  deleteEntry(id) {
    return this.#put('entries', { id, deleted: true });
  }

  restoreEntry(id) {
    return this.#put('entries', { id, deleted: false });
  }

  deleteCustomer(id) {
    return this.#put('customers', { id, deleted: true });
  }

  start(customerId, note = '') {
    const now = Date.now();
    const running = this.running;
    if (running) this.saveEntry({ id: running.id, end: Math.max(now, running.start) });
    return this.saveEntry({ customer_id: customerId, start: now, end: null, note });
  }

  stop() {
    const running = this.running;
    if (!running) return null;
    return this.saveEntry({ id: running.id, end: Math.max(Date.now(), running.start) });
  }

  // ---- Synchronisation ----
  scheduleSync(delay = 0) {
    clearTimeout(this.#syncTimer);
    this.#syncTimer = setTimeout(() => this.sync(), delay);
  }

  async sync() {
    if (this.#syncing) return this.#syncing;
    this.#syncing = this.#doSync().finally(() => { this.#syncing = null; });
    return this.#syncing;
  }

  async #doSync() {
    if (this.status === 'auth') return;
    const sent = {
      customers: Object.values(this.state.pending.customers),
      entries: Object.values(this.state.pending.entries),
    };
    this.#setStatus('syncing');
    let res;
    try {
      const t0 = Date.now();
      res = await fetch('api/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ since: this.state.rev, changes: sent }),
        credentials: 'same-origin',
      });
      if (res.status === 401) return this.#setStatus('auth');
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
      const data = await res.json();
      const t1 = Date.now();
      this.state.clockOffset = Math.round(data.serverTime - (t0 + t1) / 2);

      // Bestätigte Änderungen aus der Warteschlange entfernen (nur wenn inzwischen nicht erneut geändert)
      for (const kind of ['customers', 'entries']) {
        for (const rec of sent[kind]) {
          if (this.state.pending[kind][rec.id]?.updated_at === rec.updated_at) delete this.state.pending[kind][rec.id];
        }
        for (const rec of data[kind]) {
          const pending = this.state.pending[kind][rec.id];
          if (pending && pending.updated_at > rec.updated_at) continue;
          const local = this.state[kind][rec.id];
          if (!local || local.updated_at <= rec.updated_at) this.state[kind][rec.id] = rec;
        }
      }
      this.state.rev = data.rev;
      this.state.lastSync = Date.now();
      this.#persist();
      this.#emit();
      this.#setStatus('idle');
      if (this.pendingCount) this.scheduleSync(500);
    } catch (err) {
      this.lastError = err.message;
      this.#setStatus(navigator.onLine === false || err instanceof TypeError ? 'offline' : 'error');
      this.scheduleSync(30000);
    }
  }

  async login(password) {
    const res = await fetch('api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
      credentials: 'same-origin',
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Anmeldung fehlgeschlagen.');
    this.#setStatus('idle');
    await this.sync();
  }

  async logout(all = false) {
    await api(all ? 'api/logout-all' : 'api/logout', { method: 'POST' }).catch(() => {});
    this.#setStatus('auth');
  }

  /** Lokalen Bestand verwerfen und komplett neu vom Server laden (ungesendete Änderungen bleiben erhalten). */
  async resync() {
    const pending = this.state.pending;
    this.state = { ...emptyState(), pending };
    for (const kind of ['customers', 'entries']) Object.assign(this.state[kind], pending[kind]);
    this.#persist();
    this.#emit();
    await this.sync();
  }

  markAuthRequired() {
    this.#setStatus('auth');
  }
}

export const store = new Store();

/** JSON-API-Aufruf; wirft Error mit Servermeldung. */
export async function api(url, { method = 'GET', body } = {}) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !url.endsWith('/logout')) store.markAuthRequired();
  if (!res.ok) throw new Error(data.error || `Fehler ${res.status}`);
  return data;
}
