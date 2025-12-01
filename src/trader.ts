import { ethers } from "ethers";
import { db } from "./db.js";
import {
  LIVE_TRADING_ENABLED,
  LIVE_DRY_RUN,
  RPC_URL,
  PRIVATE_KEY,
  MAX_GAS_GWEI,
  MIN_BALANCE_MATIC,
} from "./config.js";

type LiveTrade = {
  leaderTradeId: number;
  leaderWallet: string;
  conditionId: string;
  side: "BUY" | "SELL";
  size: number;
  price: number;
  notional: number;
};

const insertLiveFill = db.prepare(
  `INSERT INTO live_fills(leader_trade_id, leader_wallet, condition_id, side, price, size, notional, status, tx_hash, fee, submitted_at, confirmed_at, created_at, error)
   VALUES(@leaderTradeId, @leaderWallet, @conditionId, @side, @price, @size, @notional, @status, @txHash, @fee, @submittedAt, @confirmedAt, strftime('%s','now')*1000, @error)`
);

function requireEnv() {
  if (!RPC_URL) throw new Error("RPC_URL is required for live trading");
  if (!PRIVATE_KEY) throw new Error("PRIVATE_KEY is required for live trading");
}

async function ensureGasBalance(provider: ethers.JsonRpcProvider, wallet: ethers.Wallet) {
  const bal = await provider.getBalance(wallet.address);
  const minWei = ethers.parseUnits(MIN_BALANCE_MATIC.toString(), "ether");
  if (bal < minWei) {
    throw new Error(`Insufficient MATIC for gas: balance ${ethers.formatEther(bal)} < min ${MIN_BALANCE_MATIC}`);
  }
}

/**
 * Execute a live trade. Currently supports DRY_RUN. When LIVE_DRY_RUN=false, you must implement
 * the actual Polymarket order submission here.
 */
export async function executeLiveTrade(trade: LiveTrade): Promise<string> {
  if (!LIVE_TRADING_ENABLED) {
    insertLiveFill.run({ ...trade, status: "DISABLED", txHash: null, fee: 0, submittedAt: Date.now(), confirmedAt: null, error: "LIVE_TRADING_DISABLED" });
    return "live-disabled";
  }

  requireEnv();

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

  await ensureGasBalance(provider, wallet);

  if (LIVE_DRY_RUN) {
    insertLiveFill.run({ ...trade, status: "DRY_RUN", txHash: null, fee: 0, submittedAt: Date.now(), confirmedAt: null, error: null });
    return "dry-run";
  }

  // TODO: Integrate Polymarket execution here. This is intentionally left as a safeguard.
  // Steps: build order/tx, set gas caps using MAX_GAS_GWEI, send tx, await receipt, handle errors.
  const errMsg = "Live trading send not implemented; integrate Polymarket order routing.";
  insertLiveFill.run({ ...trade, status: "FAILED", txHash: null, fee: 0, submittedAt: Date.now(), confirmedAt: null, error: errMsg });
  throw new Error(errMsg);
}
