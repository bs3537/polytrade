import dotenv from "dotenv";

dotenv.config();

export const DATA_API_BASE = process.env.DATA_API_BASE ?? "https://data-api.polymarket.com";
export const GAMMA_API_BASE = process.env.GAMMA_API_BASE ?? "https://gamma-api.polymarket.com";
export const DB_PATH = process.env.DB_PATH ?? "./data/trades.db";
export const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? 10000);
export const MY_WALLET = process.env.MY_WALLET ?? "";
export const USDC_ADDRESS = process.env.USDC_ADDRESS ?? "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"; // Polygon USDC.e
export const PAPER_MODE = (process.env.PAPER_MODE ?? "false").toLowerCase() === "true";
export const PAPER_START_EQUITY = Number(process.env.PAPER_START_EQUITY ?? 100000);
export const PAPER_SLIPPAGE_BPS = Number(process.env.PAPER_SLIPPAGE_BPS ?? 50); // 0.50%
export const PAPER_SIZE_MODE = (process.env.PAPER_SIZE_MODE ?? "LEADER_PCT").toUpperCase(); // LEADER_PCT | FIXED
export const RTDS_ENABLED = (process.env.RTDS_ENABLED ?? "true").toLowerCase() === "true";
export const HISTORICAL_INGEST_ENABLED = (process.env.HISTORICAL_INGEST_ENABLED ?? "true").toLowerCase() === "true";
export const LIVE_TRADING_ENABLED = (process.env.LIVE_TRADING_ENABLED ?? "false").toLowerCase() === "true";
export const LIVE_DRY_RUN = (process.env.LIVE_DRY_RUN ?? "true").toLowerCase() === "true";
export const RPC_URL = process.env.RPC_URL ?? "";
export const PRIVATE_KEY = process.env.PRIVATE_KEY ?? "";
// Explicit chain id lets us skip provider network detection (reduces RPC noise/startup errors)
export const CHAIN_ID = Number(process.env.CHAIN_ID ?? 137);
export const MAX_GAS_GWEI = Number(process.env.MAX_GAS_GWEI ?? 150);
export const MIN_BALANCE_MATIC = Number(process.env.MIN_BALANCE_MATIC ?? 0.2);
export const USE_MY_WALLET_DIRECT = (process.env.USE_MY_WALLET_DIRECT ?? "true").toLowerCase() === "true";
// Cache wallet gas balance checks to avoid hammering the RPC for every trade
export const GAS_BALANCE_TTL_MS = Number(process.env.GAS_BALANCE_TTL_MS ?? 120000); // 2 minutes

// Sports leaders feature
export const SPORTS_LEADERS = (process.env.SPORTS_LEADERS ?? "")
  .split(",")
  .map((w) => w.trim().toLowerCase())
  .filter((w) => w.length > 0);
export const SPORTS_POLL_INTERVAL_MS = Number(process.env.SPORTS_POLL_INTERVAL_MS ?? 60000);
export const SPORTS_SIZE_THRESHOLD = Number(process.env.SPORTS_SIZE_THRESHOLD ?? 0);
export const SPORTS_CATEGORY = (process.env.SPORTS_CATEGORY ?? "sports").toLowerCase();

export const WALLETS = (process.env.WALLETS ?? "")
  .split(",")
  .map((w) => w.trim())
  .filter((w) => w.length > 0);

if (WALLETS.length === 0) {
  console.warn("No wallets configured. Set WALLETS in .env.");
}

if (!MY_WALLET) {
  console.warn("MY_WALLET not set in .env (needed for equity sizing).");
}

if (SPORTS_LEADERS.length === 0) {
  console.warn("No sports leaders configured. Set SPORTS_LEADERS in .env to enable sports tab.");
}
