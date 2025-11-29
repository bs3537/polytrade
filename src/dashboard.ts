import path from "path";
import { fileURLToPath } from "url";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyCors from "@fastify/cors";
import { db, initDb } from "./db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, "..", "public");

const fastify = Fastify({ logger: false });

async function build() {
  initDb();
  fastify.addHook("onRequest", (req, _reply, done) => {
    console.log(`[req] ${req.method} ${req.url}`);
    done();
  });
  await fastify.register(fastifyCors, { origin: "*" });
  await fastify.register(fastifyStatic, {
    root: publicDir,
    prefix: "/",
    wildcard: false,
  });

  fastify.get("/healthz", async () => ({ ok: true }));

  fastify.get("/api/portfolio", async () => {
    console.log("portfolio: start");
    // Recompute live to avoid stale snapshots
    const positions = db
      .prepare("SELECT size, avg_price, condition_id FROM paper_positions")
      .all() as any[];
    console.log("portfolio: positions", positions.length);
    const latestMap = db
      .prepare(
        `
        SELECT lt.condition_id, lt.price
        FROM leader_trades lt
        JOIN (
          SELECT condition_id, MAX(id) AS max_id
          FROM leader_trades
          GROUP BY condition_id
        ) last ON last.max_id = lt.id
      `
      )
      .all() as any[];
    console.log("portfolio: latest", latestMap.length);
    const latest = latestMap.reduce((m: Record<string, number>, r: any) => {
      m[r.condition_id] = Number(r.price);
      return m;
    }, {});
    const unreal = positions.reduce((acc, r) => {
      const mark = latest[r.condition_id] ?? Number(r.avg_price);
      return acc + Number(r.size) * (mark - Number(r.avg_price));
    }, 0);
    const posValue = positions.reduce((acc, r) => {
      const mark = latest[r.condition_id] ?? Number(r.avg_price);
      return acc + Number(r.size) * mark;
    }, 0);
    const cashRow = db.prepare("SELECT value FROM paper_state WHERE key='paper_cash'").get() as any;
    const cash = cashRow ? Number(cashRow.value) : 0;
    const realizedRow = db.prepare("SELECT value FROM paper_state WHERE key='paper_realized'").get() as any;
    const realized = realizedRow ? Number(realizedRow.value) : 0;
    const equity = cash + posValue;
    return {
      equity,
      cash,
      unrealized: unreal,
      realized,
      timestamp: Date.now(),
    };
  });

  fastify.get("/api/positions", async () => {
    const rows = db
      .prepare(
        `SELECT
            p.leader_wallet,
            p.condition_id,
            SUM(p.size) AS size,
            SUM(p.size * p.avg_price) / NULLIF(SUM(p.size),0) AS avg_price,
            MAX(p.updated_at) AS updated_at,
            m.title,
            (
              SELECT price FROM leader_trades lt
              WHERE lt.condition_id = p.condition_id
              ORDER BY lt.timestamp DESC
              LIMIT 1
            ) AS mark_price
         FROM paper_positions p
         LEFT JOIN markets m ON m.condition_id = p.condition_id
         GROUP BY p.leader_wallet, p.condition_id, m.title`
      )
      .all();
    return rows.map((r: any) => {
      const mark = Number(r.mark_price ?? r.avg_price);
      const unreal = Number(r.size) * (mark - Number(r.avg_price));
      const notional = Number(r.size) * Number(r.avg_price);
      return { ...r, mark_price: mark, unrealized: unreal, notional };
    });
  });

  fastify.get("/api/closed", async (req) => {
    const limit = Number((req.query as any)?.limit ?? 50);
    const rows = db
      .prepare(
        `SELECT f.id, f.leader_wallet, f.condition_id, f.side, f.price, f.size, f.notional,
                f.timestamp, COALESCE(m.title, lt.market_title) as title
         FROM paper_fills f
         LEFT JOIN leader_trades lt ON lt.id = f.leader_trade_id
         LEFT JOIN markets m ON m.condition_id = f.condition_id
         WHERE f.side = 'SELL' -- proxy: sells often close/reduce; we compute realized from fills
         ORDER BY f.id DESC
         LIMIT ?`
      )
      .all(limit);
    return rows;
  });

  fastify.get("/api/fills", async (req) => {
    const limit = Number((req.query as any)?.limit ?? 50);
    const rows = db
      .prepare(
        `SELECT f.leader_wallet, f.condition_id, f.side, f.price, f.size, f.notional, f.timestamp,
                COALESCE(m.title, lt.market_title) as title
         FROM paper_fills f
         LEFT JOIN leader_trades lt ON lt.id = f.leader_trade_id
         LEFT JOIN markets m ON m.condition_id = f.condition_id
         ORDER BY f.id DESC
         LIMIT ?`
      )
      .all(limit);
    return rows;
  });

  fastify.get("/api/equity", async (req) => {
    const q = (req.query ?? {}) as any;
    const intervalSec = Number(q.intervalSec ?? 300); // default 5m
    const limit = Number(q.limit ?? 288); // default ~24h at 5m

    // Pick the latest sample per bucket
    const rows = db
      .prepare(
        `
        WITH buckets AS (
          SELECT CAST(timestamp/1000/? AS INT) AS bucket, MAX(timestamp) AS max_ts
          FROM paper_portfolio
          GROUP BY bucket
          ORDER BY max_ts DESC
          LIMIT ?
        )
        SELECT p.timestamp, p.equity, p.cash, p.unrealized, p.realized
        FROM paper_portfolio p
        JOIN buckets b ON p.timestamp = b.max_ts
        ORDER BY p.timestamp ASC
      `
      )
      .all(intervalSec, limit);
    return rows;
  });

  fastify.setNotFoundHandler((req, reply) => {
    reply.redirect("/");
  });

  fastify.setErrorHandler((error, _request, reply) => {
    console.error("dashboard error", error);
    reply.status(500).send({ error: error.message ?? "internal error" });
  });

  const port = Number(process.env.PORT ?? process.env.DASHBOARD_PORT ?? 3000);
  await fastify.listen({ port, host: "0.0.0.0" });
  console.log(`Dashboard running at http://localhost:${port}`);
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});
