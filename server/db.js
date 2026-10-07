import mysql from 'mysql2/promise';

export const DEFAULT_SETTINGS = {
  reminderHours: 8, // 0 = aus
  monthlyReport: true,
  weeklyReport: false,
};

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS customers (
    id VARCHAR(64) PRIMARY KEY,
    name VARCHAR(200) NOT NULL,
    archived TINYINT NOT NULL DEFAULT 0,
    deleted TINYINT NOT NULL DEFAULT 0,
    updated_at BIGINT NOT NULL,
    rev BIGINT NOT NULL,
    INDEX customers_rev (rev)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS entries (
    id VARCHAR(64) PRIMARY KEY,
    customer_id VARCHAR(64) NOT NULL,
    \`start\` BIGINT NOT NULL,
    \`end\` BIGINT NULL,
    note TEXT NOT NULL,
    deleted TINYINT NOT NULL DEFAULT 0,
    updated_at BIGINT NOT NULL,
    rev BIGINT NOT NULL,
    reminder_sent_at BIGINT NULL,
    INDEX entries_rev (rev),
    INDEX entries_start (\`start\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS kv (
    \`key\` VARCHAR(64) PRIMARY KEY,
    value TEXT NOT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS sessions (
    token_hash CHAR(64) PRIMARY KEY,
    created_at BIGINT NOT NULL,
    last_seen BIGINT NOT NULL,
    user_agent VARCHAR(255) NOT NULL DEFAULT ''
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS report_log (
    period VARCHAR(32) PRIMARY KEY,
    sent_at BIGINT NOT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS rev_counter (
    id TINYINT PRIMARY KEY,
    value BIGINT NOT NULL
  ) ENGINE=InnoDB`,
  `INSERT IGNORE INTO rev_counter (id, value) VALUES (1, 0)`,
];

const ENTRY_COLS = 'id, customer_id, `start`, `end`, note, deleted, updated_at, rev';
const CUSTOMER_COLS = 'id, name, archived, deleted, updated_at, rev';

// MySQL liefert BIGINT je nach Treiber-Einstellung als String – hier vereinheitlichen
const num = (v) => (v == null ? null : Number(v));
const toEntry = (r) => ({
  id: r.id, customer_id: r.customer_id, start: num(r.start), end: num(r.end), note: r.note,
  deleted: Boolean(r.deleted), updated_at: num(r.updated_at), rev: num(r.rev),
});
const toCustomer = (r) => ({
  id: r.id, name: r.name, archived: Boolean(r.archived), deleted: Boolean(r.deleted),
  updated_at: num(r.updated_at), rev: num(r.rev),
});

export const CUSTOMER_FIELDS = ['name', 'archived', 'deleted'];
export const ENTRY_FIELDS = ['customer_id', 'start', 'end', 'note', 'deleted'];

/**
 * Feldweises Zusammenführen: Ein Feld vom Gerät wird übernommen, wenn es neuer ist als der letzte
 * Stand genau dieses Feldes auf dem Server. Gibt null zurück, wenn sich nichts ändert.
 */
export function mergeRecord(cur, incoming, allFields) {
  const changed = Array.isArray(incoming.fields) ? allFields.filter((f) => incoming.fields.includes(f)) : allFields;
  const ts = incoming.updated_at;
  if (!cur) {
    const fieldTs = Object.fromEntries(allFields.map((f) => [f, ts]));
    return { rec: { ...incoming, updated_at: ts }, fieldTs: JSON.stringify(fieldTs) };
  }
  let fieldTs = {};
  try { fieldTs = JSON.parse(cur.field_ts || '{}') ?? {}; } catch { fieldTs = {}; }
  // Einträge aus älteren Versionen haben keine Feld-Zeitstempel: einmalig mit dem bisherigen Stand belegen
  for (const f of allFields) fieldTs[f] ??= cur.updated_at;
  const rec = { ...cur };
  let any = false;
  for (const f of changed) {
    if (ts > fieldTs[f]) {
      rec[f] = incoming[f];
      fieldTs[f] = ts;
      any = true;
    }
  }
  if (!any) return null;
  rec.updated_at = Math.max(cur.updated_at, ts);
  delete rec.field_ts;
  return { rec, fieldTs: JSON.stringify(fieldTs) };
}

async function ensureColumn(pool, table, column, ddl) {
  const [rows] = await pool.query(
    'SELECT 1 FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?',
    [table, column],
  );
  if (!rows.length) await pool.query(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}

export async function openDb(dbConfig) {
  const opts = dbConfig.uri ? { uri: dbConfig.uri } : { ...dbConfig };
  const pool = mysql.createPool({ ...opts, connectionLimit: 5, charset: 'utf8mb4', supportBigNumbers: true });
  for (const stmt of SCHEMA) await pool.query(stmt);
  await ensureColumn(pool, 'customers', 'field_ts', 'field_ts TEXT NULL');
  await ensureColumn(pool, 'entries', 'field_ts', 'field_ts TEXT NULL');
  return new Store(pool);
}

export class Store {
  constructor(pool) {
    this.pool = pool;
  }

  close() {
    return this.pool.end();
  }

  async tx(fn) {
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      const result = await fn(conn);
      await conn.commit();
      return result;
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  }

  // ---- Key/Value ----
  async kvGet(key, dflt = null) {
    const [rows] = await this.pool.query('SELECT value FROM kv WHERE `key` = ?', [key]);
    return rows.length ? JSON.parse(rows[0].value) : dflt;
  }

  async kvSet(key, value) {
    const json = JSON.stringify(value);
    const [res] = await this.pool.query('INSERT IGNORE INTO kv (`key`, value) VALUES (?, ?)', [key, json]);
    if (!res.affectedRows) await this.pool.query('UPDATE kv SET value = ? WHERE `key` = ?', [json, key]);
  }

  async getSettings() {
    return { ...DEFAULT_SETTINGS, ...(await this.kvGet('settings', {})) };
  }

  async saveSettings(input) {
    const next = await this.getSettings();
    if (input.reminderHours !== undefined) {
      const h = Number(input.reminderHours);
      if (!Number.isFinite(h) || h < 0 || h > 48) throw new RangeError('Erinnerung muss zwischen 0 und 48 Stunden liegen');
      next.reminderHours = h;
    }
    if (input.monthlyReport !== undefined) next.monthlyReport = Boolean(input.monthlyReport);
    if (input.weeklyReport !== undefined) next.weeklyReport = Boolean(input.weeklyReport);
    await this.kvSet('settings', next);
    return next;
  }

  // ---- Sync ----
  async currentRev() {
    const [rows] = await this.pool.query('SELECT value FROM rev_counter WHERE id = 1');
    return Number(rows[0].value);
  }

  /** Atomar die nächste Revisionsnummer holen (innerhalb einer Transaktion). */
  static async nextRev(conn) {
    await conn.query('UPDATE rev_counter SET value = LAST_INSERT_ID(value + 1) WHERE id = 1');
    const [rows] = await conn.query('SELECT LAST_INSERT_ID() AS rev');
    return Number(rows[0].rev);
  }

  /**
   * Alle Änderungen seit `rev` – plus den aktuellen Stand der Datensätze mit den übergebenen IDs,
   * damit ein Gerät auch dann den Server-Stand erhält, wenn seine Änderung abgelehnt wurde.
   */
  async changesSince(rev, { customerIds = [], entryIds = [] } = {}) {
    const query = async (table, cols, ids, map) => {
      const [rows] = ids.length
        ? await this.pool.query(`SELECT ${cols} FROM ${table} WHERE rev > ? OR id IN (?)`, [rev, ids])
        : await this.pool.query(`SELECT ${cols} FROM ${table} WHERE rev > ?`, [rev]);
      return rows.map(map);
    };
    return {
      customers: await query('customers', CUSTOMER_COLS, customerIds, toCustomer),
      entries: await query('entries', ENTRY_COLS, entryIds, toEntry),
    };
  }

  /**
   * Änderungen vom Client übernehmen – feldweise Last-Write-Wins.
   * Geräte schicken in `fields` nur die Felder, die sie geändert haben. Jedes Feld hat einen eigenen
   * Zeitstempel (field_ts), damit z. B. ein Stopp auf dem PC nicht die Notiz vom Handy überschreibt.
   * Fehlt `fields` (ältere App-Version), gelten alle Felder als geändert.
   * Gibt die Anzahl geänderter Datensätze zurück.
   */
  async applyChanges({ customers = [], entries = [] }) {
    return this.tx(async (conn) => {
      let applied = 0;
      for (const c of customers) {
        const [rows] = await conn.query(`SELECT ${CUSTOMER_COLS}, field_ts FROM customers WHERE id = ? FOR UPDATE`, [c.id]);
        const merged = mergeRecord(rows[0] && { ...toCustomer(rows[0]), field_ts: rows[0].field_ts }, c, CUSTOMER_FIELDS);
        if (!merged) continue;
        const rev = await Store.nextRev(conn);
        const values = [merged.rec.name, merged.rec.archived ? 1 : 0, merged.rec.deleted ? 1 : 0, merged.rec.updated_at, rev, merged.fieldTs];
        if (rows.length) {
          await conn.query('UPDATE customers SET name = ?, archived = ?, deleted = ?, updated_at = ?, rev = ?, field_ts = ? WHERE id = ?', [...values, c.id]);
        } else {
          await conn.query('INSERT INTO customers (name, archived, deleted, updated_at, rev, field_ts, id) VALUES (?, ?, ?, ?, ?, ?, ?)', [...values, c.id]);
        }
        applied++;
      }
      for (const e of entries) {
        const [rows] = await conn.query(`SELECT ${ENTRY_COLS}, reminder_sent_at, field_ts FROM entries WHERE id = ? FOR UPDATE`, [e.id]);
        const cur = rows[0] && { ...toEntry(rows[0]), field_ts: rows[0].field_ts };
        const merged = mergeRecord(cur, e, ENTRY_FIELDS);
        if (!merged) continue;
        let next = merged.rec;
        // Passt die Kombination nicht zusammen (Ende vor Start), gilt der Eintrag des Geräts komplett
        if (next.end != null && next.end < next.start) next = { ...next, start: e.start, end: e.end };
        // Erinnerung behalten, solange der Timer mit unveränderter Startzeit läuft
        const keepReminder = cur && cur.start === next.start && next.end == null;
        const rev = await Store.nextRev(conn);
        const values = [next.customer_id, next.start, next.end, next.note ?? '', next.deleted ? 1 : 0, next.updated_at, rev,
          keepReminder ? rows[0].reminder_sent_at : null, merged.fieldTs];
        if (rows.length) {
          await conn.query(
            'UPDATE entries SET customer_id = ?, `start` = ?, `end` = ?, note = ?, deleted = ?, updated_at = ?, rev = ?, reminder_sent_at = ?, field_ts = ? WHERE id = ?',
            [...values, e.id],
          );
        } else {
          await conn.query(
            'INSERT INTO entries (customer_id, `start`, `end`, note, deleted, updated_at, rev, reminder_sent_at, field_ts, id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [...values, e.id],
          );
        }
        applied++;
      }
      return applied;
    });
  }

  // ---- Auswertung / Jobs ----
  async allCustomers() {
    const [rows] = await this.pool.query(`SELECT ${CUSTOMER_COLS} FROM customers WHERE deleted = 0`);
    return rows.map(toCustomer);
  }

  async entriesBetween(from, to) {
    const [rows] = await this.pool.query(
      `SELECT ${ENTRY_COLS} FROM entries WHERE deleted = 0 AND \`start\` >= ? AND \`start\` < ?`, [from, to],
    );
    return rows.map(toEntry);
  }

  async runningEntries() {
    const [rows] = await this.pool.query(`SELECT ${ENTRY_COLS}, reminder_sent_at FROM entries WHERE deleted = 0 AND \`end\` IS NULL`);
    return rows.map((r) => ({ ...toEntry(r), reminder_sent_at: num(r.reminder_sent_at) }));
  }

  async markReminderSent(id, ts) {
    await this.pool.query('UPDATE entries SET reminder_sent_at = ? WHERE id = ?', [ts, id]);
  }

  async reportSent(period) {
    const [rows] = await this.pool.query('SELECT 1 FROM report_log WHERE period = ?', [period]);
    return rows.length > 0;
  }

  async markReportSent(period, ts) {
    await this.pool.query('INSERT IGNORE INTO report_log (period, sent_at) VALUES (?, ?)', [period, ts]);
  }

  // ---- Sessions ----
  async createSession(tokenHash, userAgent, now) {
    await this.pool.query(
      'INSERT INTO sessions (token_hash, created_at, last_seen, user_agent) VALUES (?, ?, ?, ?)',
      [tokenHash, now, now, userAgent.slice(0, 255)],
    );
  }

  async getSession(tokenHash) {
    const [rows] = await this.pool.query('SELECT * FROM sessions WHERE token_hash = ?', [tokenHash]);
    return rows.length ? { ...rows[0], last_seen: Number(rows[0].last_seen) } : null;
  }

  async touchSession(tokenHash, now) {
    await this.pool.query('UPDATE sessions SET last_seen = ? WHERE token_hash = ?', [now, tokenHash]);
  }

  async deleteSession(tokenHash) {
    await this.pool.query('DELETE FROM sessions WHERE token_hash = ?', [tokenHash]);
  }

  async deleteAllSessions() {
    await this.pool.query('DELETE FROM sessions');
  }

  async purgeSessions(olderThan) {
    await this.pool.query('DELETE FROM sessions WHERE last_seen < ?', [olderThan]);
  }
}
