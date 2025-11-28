import { WALLETS, MY_WALLET } from "./config.js";
import { fetchPortfolioValue } from "./polymarket.js";

async function main() {
  if (!MY_WALLET) {
    console.error("Set MY_WALLET in .env");
    process.exit(1);
  }
  if (WALLETS.length === 0) {
    console.error("Set WALLETS (leaders) in .env");
    process.exit(1);
  }

  const value = await fetchPortfolioValue(MY_WALLET);
  const perLeader = value / WALLETS.length;

  console.log(`Current portfolio value for ${MY_WALLET}: ${value.toFixed(2)} USDC`);
  console.log(`Leaders configured: ${WALLETS.length}`);
  console.log(`Target allocation per leader: ${perLeader.toFixed(2)} USDC`);
  console.log("Leaders:");
  WALLETS.forEach((w) => console.log(`- ${w}`));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
