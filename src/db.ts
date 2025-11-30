import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { DB_PATH } from "./config.js";

function ensurePathWritable(p: string): string {
  const dir = path.dirname(p);
  if (dir && dir !== "." && !fs.existsSync(dir)) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      return p;
    } catch {
      // fall through to fallback
    }
  }
  return p;
}

let resolvedPath = DB_PATH;
resolvedPath = ensurePathWritable(resolvedPath);

// If absolute /data is not writable (no Render disk), fall back to local ./data
if (!fs.existsSync(path.dirname(resolvedPath))) {
  const fallback = path.resolve("data", path.basename(DB_PATH));
  fs.mkdirSync(path.dirname(fallback), { recursive: true });
  resolvedPath = fallback;
}

export const db = new Database(resolvedPath);

// Be resilient to transient locks during zero-downtime deploys.
try {
  db.pragma("busy_timeout = 10000");
  db.pragma("journal_mode = WAL");
  db.pragma("wal_autocheckpoint = 1000"); // checkpoint roughly every 1000 pages (~1MB default page size)
  db.pragma("journal_size_limit = 134217728"); // cap WAL to ~128MB to avoid disk bloat
} catch (err: any) {
  console.warn("SQLite pragma setup skipped (continuing without WAL):", err?.message ?? err);
}

export function initDb() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS leader_trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      proxy_wallet TEXT NOT NULL,
      transaction_hash TEXT NOT NULL,
      condition_id TEXT,
      asset_id TEXT,
      side TEXT,
      size REAL,
      price REAL,
      timestamp INTEGER,
      market_slug TEXT,
      market_title TEXT,
      UNIQUE(proxy_wallet, transaction_hash, asset_id, side, size, price, timestamp)
    );
    CREATE INDEX IF NOT EXISTS idx_leader_trades_condition_ts ON leader_trades(condition_id, timestamp);
    CREATE INDEX IF NOT EXISTS idx_leader_trades_condition_id ON leader_trades(condition_id, id);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS markets (
      condition_id TEXT PRIMARY KEY,
      slug TEXT,
      title TEXT,
      category TEXT,
      end_date TEXT,
      updated_at INTEGER
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS copy_orders_intent (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      leader_trade_id INTEGER,
      proxy_wallet TEXT,
      condition_id TEXT,
      side TEXT,
      desired_size REAL,
      desired_notional REAL,
      rule_label TEXT,
      created_at INTEGER,
      status TEXT DEFAULT 'INTENDED',
      FOREIGN KEY(leader_trade_id) REFERENCES leader_trades(id)
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS paper_positions (
      condition_id TEXT NOT NULL,
      outcome TEXT NOT NULL DEFAULT '',
      leader_wallet TEXT NOT NULL,
      size REAL NOT NULL,
      avg_price REAL NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(condition_id, outcome, leader_wallet)
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS paper_fills (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      leader_trade_id INTEGER,
      leader_wallet TEXT NOT NULL,
      condition_id TEXT NOT NULL,
      side TEXT NOT NULL,
      price REAL NOT NULL,
      size REAL NOT NULL,
      notional REAL NOT NULL,
      timestamp INTEGER NOT NULL,
      rule_label TEXT,
      created_at INTEGER NOT NULL
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS paper_portfolio (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER NOT NULL,
      equity REAL NOT NULL,
      cash REAL NOT NULL,
      unrealized REAL NOT NULL,
      realized REAL NOT NULL
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS paper_state (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);
}
