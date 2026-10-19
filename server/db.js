// Tiny database layer: PostgreSQL when DATABASE_URL is set (recommended on Railway),
// otherwise SQLite in DATA_DIR. Queries are written with `?` placeholders.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';

let driver;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  prefs TEXT NOT NULL DEFAULT '{}',
  hook_token TEXT UNIQUE NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conv_user ON conversations(user_id, updated_at);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  meta TEXT NOT NULL DEFAULT '{}',
  raw TEXT NOT NULL DEFAULT '[]',
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conversation_id, created_at);
CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  mime TEXT NOT NULL,
  size BIGINT NOT NULL,
  data {{BLOB}} NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  UNIQUE(user_id, path)
);
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id TEXT,
  title TEXT NOT NULL,
  prompt TEXT NOT NULL,
  every_minutes INTEGER,
  next_run_at BIGINT NOT NULL,
  last_run_at BIGINT,
  last_result TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(enabled, next_run_at);
CREATE TABLE IF NOT EXISTS integrations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  url TEXT NOT NULL,
  headers TEXT NOT NULL DEFAULT '{}',
  description TEXT NOT NULL DEFAULT '',
  created_at BIGINT NOT NULL,
  UNIQUE(user_id, name)
);
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT UNIQUE NOT NULL,
  data TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

async function initPostgres() {
  const pg = (await import('pg')).default;
  pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v))); // BIGINT -> number
  if (/\$\{\{/.test(config.databaseUrl)) {
    throw new Error('DATABASE_URL contains an unresolved Railway reference. Use the variable reference picker so it becomes ${{Postgres.DATABASE_URL}} and make sure the Postgres service exists.');
  }
  // Railway's private network doesn't use TLS; public/managed hosts usually do (often with self-signed certs).
  let ssl = /sslmode=disable/.test(config.databaseUrl) || /\.railway\.internal|localhost|127\.0\.0\.1/.test(config.databaseUrl)
    ? false
    : { rejectUnauthorized: false };
  const connectionString = config.databaseUrl.replace(/([?&])sslmode=[^&]*&?/, '$1').replace(/[?&]$/, '');
  const toPg = (sql) => {
    let i = 0;
    return sql.replace(/\?/g, () => `$${++i}`);
  };

  // The database (or Railway's private DNS) may not be ready the instant we boot, so retry for a while.
  let pool;
  for (let attempt = 1; ; attempt++) {
    pool = new pg.Pool({ connectionString, ssl, max: 10, connectionTimeoutMillis: 10000 });
    // Without this listener, a dropped idle connection would crash the whole process.
    pool.on('error', (e) => console.error('[db] idle client error:', e.message));
    try {
      await pool.query(SCHEMA.replace(/\{\{BLOB\}\}/g, 'BYTEA'));
      break;
    } catch (e) {
      await pool.end().catch(() => {});
      if (ssl && /does not support SSL/i.test(e.message)) {
        ssl = false;
        continue;
      }
      if (attempt >= 15) throw e;
      console.warn(`[db] connection attempt ${attempt} failed (${e.code || e.message}); retrying…`);
      await new Promise((r) => setTimeout(r, Math.min(2000 * attempt, 10000)));
    }
  }
  return {
    kind: 'postgres',
    async all(sql, params = []) {
      return (await pool.query(toPg(sql), params)).rows;
    },
    async get(sql, params = []) {
      return (await pool.query(toPg(sql), params)).rows[0];
    },
    async run(sql, params = []) {
      const r = await pool.query(toPg(sql), params);
      return { changes: r.rowCount };
    },
  };
}

async function initSqlite() {
  let Database;
  try {
    Database = (await import('better-sqlite3')).default;
  } catch {
    throw new Error('SQLite is unavailable. Set DATABASE_URL to a PostgreSQL database (on Railway: add the Postgres plugin).');
  }
  fs.mkdirSync(config.dataDir, { recursive: true });
  const db = new Database(path.join(config.dataDir, 'cynthia.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA.replace(/\{\{BLOB\}\}/g, 'BLOB'));
  return {
    kind: 'sqlite',
    async all(sql, params = []) {
      return db.prepare(sql).all(...params);
    },
    async get(sql, params = []) {
      return db.prepare(sql).get(...params);
    },
    async run(sql, params = []) {
      const r = db.prepare(sql).run(...params);
      return { changes: r.changes };
    },
  };
}

export async function initDb() {
  driver = config.databaseUrl ? await initPostgres() : await initSqlite();
  console.log(`[db] using ${driver.kind}`);
  return driver;
}

export const db = {
  all: (sql, params) => driver.all(sql, params),
  get: (sql, params) => driver.get(sql, params),
  run: (sql, params) => driver.run(sql, params),
};

export const id = () => crypto.randomUUID();
export const now = () => Date.now();

export async function getSetting(key) {
  const row = await db.get('SELECT value FROM settings WHERE key = ?', [key]);
  return row ? row.value : null;
}

export async function setSetting(key, value) {
  const existing = await getSetting(key);
  if (existing === null) await db.run('INSERT INTO settings (key, value) VALUES (?, ?)', [key, value]);
  else await db.run('UPDATE settings SET value = ? WHERE key = ?', [value, key]);
}

/** Returns a persisted setting, creating it with `make()` the first time. */
export async function ensureSetting(key, make) {
  let v = await getSetting(key);
  if (v === null) {
    v = make();
    await setSetting(key, v);
  }
  return v;
}
