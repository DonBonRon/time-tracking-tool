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

export async function openDb(dbConfig) {
  const opts = dbConfig.uri ? { uri: dbConfig.uri } : { ...dbConfig };
  const pool = mysql.createPool({ ...opts, connectionLimit: 5, charset: 'utf8mb4', supportBigNumbers: true });
  for (const stmt of SCHEMA) await pool.query(stmt);
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
    await this.pool.query(
      'INSERT INTO kv (`key`, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)',
      [key, JSON.stringify(value)],
    );
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

  async changesSince(rev) {
    const [customers] = await this.pool.query(`SELECT ${CUSTOMER_COLS} FROM customers WHERE rev > ?`, [rev]);
    const [entries] = await this.pool.query(`SELECT ${ENTRY_COLS} FROM entries WHERE rev > ?`, [rev]);
    return { customers: customers.map(toCustomer), entries: entries.map(toEntry) };
  }

  /**
   * Änderungen vom Client übernehmen (Last-Write-Wins anhand updated_at).
   * Gibt die Anzahl übernommener Datensätze zurück.
   */
  async applyChanges({ customers = [], entries = [] }) {
    return this.tx(async (conn) => {
      let applied = 0;
      for (const c of customers) {
        const [rows] = await conn.query('SELECT updated_at FROM customers WHERE id = ? FOR UPDATE', [c.id]);
        if (rows.length && Number(rows[0].updated_at) >= c.updated_at) continue;
        const rev = await Store.nextRev(conn);
        await conn.query(
          `INSERT INTO customers (id, name, archived, deleted, updated_at, rev) VALUES (?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE name = VALUES(name), archived = VALUES(archived), deleted = VALUES(deleted),
             updated_at = VALUES(updated_at), rev = VALUES(rev)`,
          [c.id, c.name, c.archived ? 1 : 0, c.deleted ? 1 : 0, c.updated_at, rev],
        );
        applied++;
      }
      for (const e of entries) {
        const [rows] = await conn.query(
          'SELECT updated_at, `start`, reminder_sent_at FROM entries WHERE id = ? FOR UPDATE', [e.id],
        );
        if (rows.length && Number(rows[0].updated_at) >= e.updated_at) continue;
        // Erinnerung zurücksetzen, wenn die Startzeit eines laufenden Timers geändert wurde
        const keepReminder = rows.length && Number(rows[0].start) === e.start && e.end == null;
        const rev = await Store.nextRev(conn);
        await conn.query(
          `INSERT INTO entries (id, customer_id, \`start\`, \`end\`, note, deleted, updated_at, rev, reminder_sent_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE customer_id = VALUES(customer_id), \`start\` = VALUES(\`start\`), \`end\` = VALUES(\`end\`),
             note = VALUES(note), deleted = VALUES(deleted), updated_at = VALUES(updated_at), rev = VALUES(rev),
             reminder_sent_at = VALUES(reminder_sent_at)`,
          [e.id, e.customer_id, e.start, e.end, e.note, e.deleted ? 1 : 0, e.updated_at, rev,
            keepReminder ? rows[0].reminder_sent_at : null],
        );
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
