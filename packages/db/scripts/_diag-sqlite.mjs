import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync("./prisma/dev.db");
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
console.log("Tables in dev.db:", tables.map(t => t.name).join(", ") || "(none)");

if (tables.some(t => t.name === "Fill")) {
  const fillCount   = db.prepare("SELECT COUNT(*) as n FROM Fill WHERE profileId='leader2'").get();
  const buyNotional = db.prepare("SELECT COALESCE(SUM(f.size * f.price),0) as n FROM Fill f JOIN \"Order\" o ON o.id=f.orderId JOIN CopyIntent i ON i.id=o.intentId WHERE f.profileId='leader2' AND i.side='BUY'").get();
  const sellNotional= db.prepare("SELECT COALESCE(SUM(f.size * f.price),0) as n FROM Fill f JOIN \"Order\" o ON o.id=f.orderId JOIN CopyIntent i ON i.id=o.intentId WHERE f.profileId='leader2' AND i.side='SELL'").get();
  const badFills    = db.prepare("SELECT f.size, f.price, f.size*f.price as notional, i.side FROM Fill f JOIN \"Order\" o ON o.id=f.orderId JOIN CopyIntent i ON i.id=o.intentId WHERE f.profileId='leader2' AND (f.size < 5 OR f.size*f.price < 1)").all();
  const positions   = db.prepare("SELECT tokenId, size, avgPrice FROM Position WHERE profileId='leader2'").all();
  const intents     = db.prepare("SELECT side, status, COUNT(*) as cnt, COALESCE(SUM(desiredSize),0) as ds, COALESCE(SUM(desiredNotional),0) as dn FROM CopyIntent WHERE profileId='leader2' GROUP BY side, status ORDER BY side, status").all();
  const cashMetric  = db.prepare("SELECT value FROM RuntimeMetric WHERE profileId='leader2' AND key='bot.cash_usdc'").get();

  console.log("\n=== FILLS ===");
  console.log(`Total fills:     ${fillCount.n}`);
  console.log(`Buy notional:    $${Number(buyNotional.n).toFixed(4)}`);
  console.log(`Sell notional:   $${Number(sellNotional.n).toFixed(4)}`);
  console.log(`Net cash delta:  $${(sellNotional.n - buyNotional.n).toFixed(4)}`);
  console.log(`Expected cash:   $${(50 + sellNotional.n - buyNotional.n).toFixed(4)}`);
  console.log(`DB cash metric:  ${cashMetric ? "$"+cashMetric.value : "N/A"}`);

  console.log("\n=== BAD FILLS (size<5 OR notional<$1) ===");
  if (badFills.length === 0) console.log("None found - all fills meet minimums.");
  else badFills.forEach(b => console.log(`  side=${b.side} size=${Number(b.size).toFixed(4)} price=${Number(b.price).toFixed(4)} notional=$${Number(b.notional).toFixed(4)}`));

  console.log("\n=== POSITIONS ===");
  let totalOpenCost = 0;
  for (const p of positions) {
    const cost = Number(p.size) * Number(p.avgPrice);
    if (Number(p.size) > 0.001) {
      totalOpenCost += cost;
      console.log(`  OPEN   size=${Number(p.size).toFixed(4)} avgPrice=$${Number(p.avgPrice).toFixed(4)} costBasis=$${cost.toFixed(4)}`);
    } else {
      console.log(`  CLOSED size=${Number(p.size).toFixed(4)}`);
    }
  }
  console.log(`Open cost basis: $${totalOpenCost.toFixed(4)}`);

  const expectedCash = 50 + sellNotional.n - buyNotional.n;
  console.log("\n=== EQUITY RECONCILIATION ===");
  console.log(`Starting USDC:       $50.0000`);
  console.log(`Cash (from fills):   $${expectedCash.toFixed(4)}`);
  console.log(`Open cost basis:     $${totalOpenCost.toFixed(4)}`);
  console.log(`Total equity:        $${(expectedCash + totalOpenCost).toFixed(4)}`);
  console.log(`Expected: ≤$50 if no sells, equals $50 + realised gains if sells exist`);

  console.log("\n=== INTENT BREAKDOWN ===");
  for (const r of intents) console.log(`  ${r.side.padEnd(4)} ${String(r.status).padEnd(22)} count=${r.cnt} desiredSize=${Number(r.ds).toFixed(2)} desiredNotional=$${Number(r.dn).toFixed(2)}`);
} else {
  console.log("No Fill table found — DB may be empty or reset.");
}
db.close();
