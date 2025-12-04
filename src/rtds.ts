import WebSocket from "ws";
import { WALLETS, RTDS_ENABLED } from "./config.js";

type TradeMessage = {
  proxyWallet: string;
  transactionHash: string;
  conditionId: string;
  assetId?: string;
  price: number;
  size: number;
  side: "BUY" | "SELL";
  timestamp: number; // ms
  marketSlug?: string;
  marketQuestion?: string;
};

type Handler = (trade: TradeMessage) => Promise<void> | void;

export function startRTDS(onTrade: Handler) {
  if (!RTDS_ENABLED) {
    console.log("RTDS disabled via env RTDS_ENABLED=false");
    return () => {};
  }

  const ws = new WebSocket("wss://ws-live-data.polymarket.com");

  ws.on("open", () => {
    console.log("RTDS connected");
    const sub = {
      action: "subscribe",
      topics: ["activity"],
      types: ["trades"],
    };
    ws.send(JSON.stringify(sub));
  });

  let seen = 0;

  ws.on("message", async (data: WebSocket.RawData) => {
    try {
      const msg = JSON.parse(data.toString());
      // Expect messages with type 'trades' under activity stream
      const t = msg?.data ?? msg;
      if (!t || !t.proxyWallet || !t.conditionId || !t.transactionHash) return;
      const wallet = String(t.proxyWallet).toLowerCase();
      if (!WALLETS.map((w) => w.toLowerCase()).includes(wallet)) return;

      const trade: TradeMessage = {
        proxyWallet: t.proxyWallet,
        transactionHash: t.transactionHash,
        conditionId: t.conditionId ?? t.conditionIdV2 ?? "",
        assetId: t.asset ?? t.assetId ?? t.tokenId ?? t.positionId,
        price: Number(t.price),
        size: Number(t.size),
        side: String(t.side).toUpperCase() === "SELL" ? "SELL" : "BUY",
        timestamp: (Number(t.timestamp) ?? Date.now() / 1000) * 1000,
        marketSlug: t.market?.slug ?? t.slug,
        marketQuestion: t.market?.question ?? t.question,
      };
      seen += 1;
      if (seen % 20 === 0) {
        console.log(`[rtds] ${seen} trades seen; last wallet ${wallet} market ${trade.marketSlug ?? ""}`);
      }
      await onTrade(trade);
    } catch (err) {
      // swallow parse errors
    }
  });

  ws.on("error", (err) => {
    console.error("RTDS error", err);
  });

  ws.on("close", () => {
    console.log("RTDS closed");
    // simple reconnect
    setTimeout(() => startRTDS(onTrade), 2000);
  });

  return () => {
    ws.close();
  };
}
