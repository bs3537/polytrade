import { db, initDb } from "./db.js";
import { PAPER_START_EQUITY } from "./config.js";

initDb();

db.exec("DELETE FROM paper_positions;");
db.exec("DELETE FROM paper_fills;");
db.exec("DELETE FROM paper_portfolio;");
db.exec("DELETE FROM paper_state;");

db.prepare("INSERT INTO paper_state(key, value) VALUES (?, ?)").run("paper_cash", String(PAPER_START_EQUITY));
db.prepare("INSERT INTO paper_state(key, value) VALUES (?, ?)").run("paper_realized", "0");
db.prepare("INSERT INTO paper_state(key, value) VALUES (?, ?)").run("paper_start_ts", String(Date.now()));
db.prepare(
  "INSERT INTO paper_portfolio(timestamp, equity, cash, unrealized, realized) VALUES (strftime('%s','now')*1000, ?, ?, 0, 0)"
).run(PAPER_START_EQUITY, PAPER_START_EQUITY);

console.log(`Paper state reset. Cash & equity set to ${PAPER_START_EQUITY}.`);
