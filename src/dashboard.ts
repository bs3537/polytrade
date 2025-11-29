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
  await fastify.register(fastifyCors, { origin: "*" });
  await fastify.register(fastifyStatic, {
    root: publicDir,
    prefix: "/",
    wildcard: false,
  });

  fastify.get("/api/portfolio", async () => {
    const row = db
      .prepare(
        "SELECT equity, cash, unrealized, realized, timestamp FROM paper_portfolio ORDER BY id DESC LIMIT 1"
      )
      .get();
    return (
      row ?? {
        equity: 0,
        cash: 0,
        unrealized: 0,
        realized: 0,
        timestamp: Date.now(),
      }
    );
  });

  fastify.get("/api/positions", async () => {
    const rows = db
      .prepare(
        `SELECT p.condition_id, p.leader_wallet, p.size, p.avg_price,
                (p.size * p.avg_price) as notional,
                p.updated_at,
                m.title,
                (
                  SELECT price FROM leader_trades lt
                  WHERE lt.condition_id = p.condition_id
                  ORDER BY lt.timestamp DESC
                  LIMIT 1
                ) AS mark_price
         FROM paper_positions p
         LEFT JOIN markets m ON m.condition_id = p.condition_id
         ORDER BY notional DESC`
      )
      .all();
    return rows.map((r: any) => {
      const mark = Number(r.mark_price ?? r.avg_price);
      const unreal = Number(r.size) * (mark - Number(r.avg_price));
      return { ...r, mark_price: mark, unrealized: unreal };
    });
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

  const port = Number(process.env.PORT ?? 3000);
  await fastify.listen({ port, host: "0.0.0.0" });
  console.log(`Dashboard running at http://localhost:${port}`);
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});
