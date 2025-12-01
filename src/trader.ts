import { ethers } from "ethers";
import { ClobClient, OrderType, Side, Chain } from "@polymarket/clob-client";
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
  assetId?: string;
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

const CLOB_HOST = process.env.CLOB_HOST ?? "https://clob.polymarket.com";
let clobClientPromise: Promise<ClobClient> | null = null;

async function getClobClient(): Promise<ClobClient> {
  if (clobClientPromise) return clobClientPromise;

  clobClientPromise = (async () => {
    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const wallet = new ethers.Wallet(PRIVATE_KEY, provider) as any;

    // Derive API creds, then instantiate client with creds set.
    const tmp = new ClobClient(CLOB_HOST, Chain.POLYGON, wallet);
    const creds = await tmp.createOrDeriveApiKey();
    const client = new ClobClient(CLOB_HOST, Chain.POLYGON, wallet, creds, undefined, wallet.address);
    return client;
  })();

  return clobClientPromise;
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

  try {
    const client = await getClobClient();
    const tokenID = trade.assetId ?? trade.conditionId;
    const userOrder = {
      tokenID,
      price: trade.price,
      size: trade.size,
      side: trade.side === "BUY" ? Side.BUY : Side.SELL,
    };

    const res = await client.createAndPostOrder(userOrder, {}, OrderType.GTC, false);
    const txHash = res?.orderID ?? res?.orderId ?? res?.hash ?? null;
    insertLiveFill.run({
      ...trade,
      status: "POSTED",
      txHash,
      fee: res?.fee ?? 0,
      submittedAt: Date.now(),
      confirmedAt: null,
      error: null,
    });
    return txHash ?? "order-posted";
  } catch (err: any) {
    insertLiveFill.run({
      ...trade,
      status: "FAILED",
      txHash: null,
      fee: 0,
      submittedAt: Date.now(),
      confirmedAt: null,
      error: err?.message ?? String(err),
    });
    throw err;
  }
}
