import { PrismaClient } from "@prisma/client";
process.env.DATABASE_URL ??= "file:./prisma/dev.db";
const prisma = new PrismaClient();

// 1. All fills for leader2
const fills = await prisma.fill.findMany({
  where: { profileId: "leader2" },
  include: { order: { include: { intent: true } } },
  orderBy: { ts: "asc" }
});

let totalBuyNotional = 0, totalSellNotional = 0, buyCount = 0, sellCount = 0;
const badFills = [];
for (const f of fills) {
  const side = f.order?.intent?.side ?? "?";
  const notional = f.size * f.price;
  if (side === "BUY") { totalBuyNotional += notional; buyCount++; }
  else { totalSellNotional += notional; sellCount++; }
  if (f.size < 5 || notional < 1) {
    badFills.push({ side, size: Number(f.size), price: Number(f.price), notional: Number(notional.toFixed(4)) });
  }
}
console.log("=== FILLS ===");
console.log(`BUY:  ${buyCount} fills, total notional: $${totalBuyNotional.toFixed(4)}`);
console.log(`SELL: ${sellCount} fills, total notional: $${totalSellNotional.toFixed(4)}`);
console.log(`Net cash delta: $${(totalSellNotional - totalBuyNotional).toFixed(4)}`);
console.log(`Expected cash (from fills): $${(50 + totalSellNotional - totalBuyNotional).toFixed(4)}`);
if (badFills.length) {
  console.log(`\nBAD FILLS (below minimums): ${badFills.length}`);
  for (const b of badFills) console.log(`  ${JSON.stringify(b)}`);
} else {
  console.log("No fills below minimum thresholds.");
}

// 2. All positions
const positions = await prisma.position.findMany({ where: { profileId: "leader2" } });
console.log("\n=== POSITIONS ===");
let totalOpenCostBasis = 0;
let totalRealizedPnl = 0;
for (const p of positions) {
  const costBasis = Number(p.size) * Number(p.avgPrice);
  if (Number(p.size) > 0.001) {
    totalOpenCostBasis += costBasis;
    console.log(`  OPEN   size=${Number(p.size).toFixed(4)} avgPrice=${Number(p.avgPrice).toFixed(4)} costBasis=$${costBasis.toFixed(4)} | token=${p.tokenId.slice(0,20)}...`);
  } else {
    totalRealizedPnl += Number(p.realizedPnl);
    console.log(`  CLOSED size=${Number(p.size).toFixed(4)} realizedPnl=$${Number(p.realizedPnl).toFixed(4)} | token=${p.tokenId.slice(0,20)}...`);
  }
}
console.log(`\nTotal open cost basis: $${totalOpenCostBasis.toFixed(4)}`);
console.log(`Total realized P&L (closed pos): $${totalRealizedPnl.toFixed(4)}`);

// 3. Equity check
const cashMetric = await prisma.runtimeMetric.findFirst({ where: { profileId: "leader2", key: "bot.cash_usdc" } });
const reportedCash = Number(cashMetric?.value ?? 50);
const equityFromFills = 50 + totalSellNotional - totalBuyNotional;
console.log(`\n=== EQUITY CHECK ===`);
console.log(`DB cash metric (in-memory state): $${reportedCash.toFixed(4)}`);
console.log(`Cash computed from fills:         $${equityFromFills.toFixed(4)}`);
console.log(`Open position cost basis:         $${totalOpenCostBasis.toFixed(4)}`);
console.log(`Total equity (cash + cost basis): $${(equityFromFills + totalOpenCostBasis).toFixed(4)}`);
console.log(`  ^ This should be ≤ $50 (no sells = no realised gains)`);

// 4. Intent breakdown
const intentStats = await prisma.copyIntent.groupBy({
  by: ["status", "side"],
  where: { profileId: "leader2" },
  _count: { _all: true },
  _sum: { desiredSize: true, desiredNotional: true }
});
console.log("\n=== INTENT BREAKDOWN ===");
for (const r of intentStats) {
  console.log(`  ${r.side.padEnd(4)} ${r.status.padEnd(20)} count=${r._count._all} desiredSize=${Number(r._sum.desiredSize ?? 0).toFixed(2)} desiredNotional=$${Number(r._sum.desiredNotional ?? 0).toFixed(2)}`);
}

// 5. Show any SELL fills in detail
const sellFills = fills.filter(f => f.order?.intent?.side === "SELL");
if (sellFills.length > 0) {
  console.log("\n=== SELL FILLS DETAIL ===");
  for (const f of sellFills) {
    console.log(`  size=${Number(f.size).toFixed(4)} price=${Number(f.price).toFixed(4)} notional=$${(Number(f.size)*Number(f.price)).toFixed(4)} token=${f.order?.intent?.tokenId?.slice(0,20)}...`);
  }
} else {
  console.log("\nNo SELL fills exist — all positions are unrealized.");
}

await prisma.$disconnect();
