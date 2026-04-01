import { PrismaClient } from "@prisma/client";
const db = new PrismaClient();

// Reconstruct cash balance from fills (same logic as hydratePaperRuntimeState)
const fills = await db.fill.findMany({ orderBy: { ts: "asc" } });

let cashUSDC = 50; // startingUSDC
for (const f of fills) {
  if (f.side === "BUY")  cashUSDC -= f.notional;
  if (f.side === "SELL") cashUSDC += f.notional;
}

// Open positions
const positions = await db.position.findMany();

console.log("\n=== Cash / Drawdown Diagnosis ===");
console.log("  startingUSDC (hardcoded):  $50.00");
console.log("  current cashUSDC:         $" + cashUSDC.toFixed(2));
console.log("  total drawdown from $50:  $" + (50 - cashUSDC).toFixed(2));
console.log("  maxDailyDrawdownUSDC cfg: $20.00");
console.log("  drawdown limit hit:       ", (50 - cashUSDC) >= 20 ? "YES <-- this is why it keeps pausing" : "no");
console.log("  open positions:           ", positions.length);

// Show fills by calendar day to understand if this is truly a daily check
const byDay = {};
for (const f of fills) {
  const day = new Date(f.ts).toLocaleDateString();
  byDay[day] = byDay[day] ?? { buys: 0, sells: 0, net: 0 };
  if (f.side === "BUY")  { byDay[day].buys += f.notional; byDay[day].net -= f.notional; }
  if (f.side === "SELL") { byDay[day].sells += f.notional; byDay[day].net += f.notional; }
}
console.log("\n=== Daily fill notionals ===");
for (const [day, d] of Object.entries(byDay)) {
  const net = d.net >= 0 ? "+" : "";
  console.log(`  ${day}:  buys=$${d.buys.toFixed(2)}  sells=$${d.sells.toFixed(2)}  net=${net}${d.net.toFixed(2)}`);
}

// How daily drawdown is ACTUALLY being computed (startingUSDC=50 always)
console.log("\n=== Root cause ===");
console.log("  startingUSDC is fixed at $50 (or STARTING_USDC env var).");
console.log("  drawdownUSDC = 50 - cashUSDC =", (50 - cashUSDC).toFixed(2));
console.log("  This is CUMULATIVE, not daily -- the name is misleading.");
console.log("  Every restart recomputes from $50 so if total loss > limit, bot always halts immediately.");

await db.$disconnect();
