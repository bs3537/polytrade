#!/usr/bin/env node
import Database from "better-sqlite3";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";

dotenv.config();

const configuredPath = process.env.DB_PATH || "./data/trades.db";
const fallbackPath = "./data/trades.db";
const candidatePaths = [configuredPath, fallbackPath];
const resolved = candidatePaths.map((p) => path.resolve(p)).find((p) => fs.existsSync(p));

if (!resolved) {
  console.error(
    `paper:migrate: DB not found. Tried: ${candidatePaths.map((p) => path.resolve(p)).join(", ")}`
  );
  process.exit(1);
}

const db = new Database(resolved);
db.pragma("journal_mode = WAL");

// Check if outcome is already NOT NULL
const cols = db
  .prepare("PRAGMA table_info(paper_positions)")
  .all()
  .map((c) => ({ name: c.name, notnull: Boolean(c.notnull), dflt: c.dflt_value }));

const outcomeCol = cols.find((c) => c.name === "outcome");
if (!outcomeCol) {
  console.error("paper:migrate: table paper_positions missing; nothing to do.");
  process.exit(0);
}

if (outcomeCol.notnull && outcomeCol.dflt === "''") {
  console.log("paper:migrate: outcome already NOT NULL with default ''; skipping.");
  process.exit(0);
}

console.log(`paper:migrate: migrating ${resolved}`);

const migrate = db.transaction(() => {
  db.exec(`
    ALTER TABLE paper_positions RENAME TO paper_positions_old;
    CREATE TABLE paper_positions (
      condition_id TEXT NOT NULL,
      outcome TEXT NOT NULL DEFAULT '',
      leader_wallet TEXT NOT NULL,
      size REAL NOT NULL,
      avg_price REAL NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(condition_id, outcome, leader_wallet)
    );
    INSERT INTO paper_positions
    SELECT
      condition_id,
      COALESCE(outcome, '') AS outcome,
      leader_wallet,
      SUM(size) AS size,
      CASE WHEN SUM(size) != 0 THEN SUM(size * avg_price) / SUM(size) ELSE avg(avg_price) END AS avg_price,
      MAX(updated_at) AS updated_at
    FROM paper_positions_old
    GROUP BY condition_id, outcome, leader_wallet;
    DROP TABLE paper_positions_old;
  `);
});

try {
  migrate();
  console.log("paper:migrate: success");
} catch (err) {
  console.error("paper:migrate: failed", err);
  process.exitCode = 1;
}
