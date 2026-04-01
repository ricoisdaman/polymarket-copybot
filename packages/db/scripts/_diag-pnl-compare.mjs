import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync("./prisma/dev.db");

// 1. Overall trade capture rate
const totalEvents = db.prepare("SELECT COUNT(*) as n FROM LeaderEvent WHERE profileId='leader2'").get();
const filledIntents = db.prepare("SELECT COUNT(*) as n FROM CopyIntent WHERE profileId='leader2' AND status='FILLED'").get();
const skippedIntents = db.prepare("SELECT COUNT(*) as n FROM CopyIntent WHERE profileId='leader2' AND status='SKIPPED'").get();
const skipBreakdown = db.prepare("SELECT reason, COUNT(*) as cnt FROM CopyIntent WHERE profileId='leader2' AND status='SKIPPED' GROUP BY reason ORDER BY cnt DESC").all();

console.log("=== TRADE CAPTURE RATE ===");
console.log(`Leader events seen:    ${totalEvents.n}`);
console.log(`Intents FILLED:        ${filledIntents.n}`);
console.log(`Intents SKIPPED:       ${skippedIntents.n}`);
console.log(`Capture rate:          ${(filledIntents.n / (filledIntents.n + skippedIntents.n) * 100).toFixed(1)}%`);
console.log("\nSkip reasons:");
for (const r of skipBreakdown) console.log(`  ${r.reason.padEnd(45)} ${r.cnt}`);

// 2. P&L breakdown
const buys = db.prepare("SELECT COALESCE(SUM(f.size * f.price), 0) as n, COUNT(*) as cnt FROM Fill f JOIN [Order] o ON o.id=f.orderId JOIN CopyIntent i ON i.id=o.intentId WHERE f.profileId='leader2' AND i.side='BUY'").get();
const sells = db.prepare("SELECT COALESCE(SUM(f.size * f.price), 0) as n, COUNT(*) as cnt FROM Fill f JOIN [Order] o ON o.id=f.orderId JOIN CopyIntent i ON i.id=o.intentId WHERE f.profileId='leader2' AND i.side='SELL'").get();
const positions = db.prepare("SELECT SUM(size * avgPrice) as cost, COUNT(*) as cnt FROM Position WHERE profileId='leader2' AND size > 0.001").get();
const cashMetric = db.prepare("SELECT value FROM RuntimeMetric WHERE profileId='leader2' AND key='bot.cash_usdc'").get();

const cash = cashMetric ? Number(cashMetric.value) : (50 + sells.n - buys.n);
const costBasis = Number(positions.cost ?? 0);
const totalEquity = cash + costBasis;
const pnl = totalEquity - 50;

console.log("\n=== BOT P&L BREAKDOWN ===");
console.log(`Starting USDC:         $50.00`);
console.log(`Cash now:              $${cash.toFixed(2)}`);
console.log(`Open positions (n=${positions.cnt}): $${costBasis.toFixed(2)} cost basis`);
console.log(`Total equity:          $${totalEquity.toFixed(2)}`);
console.log(`P&L (at cost basis):   $${pnl.toFixed(2)} (${(pnl/50*100).toFixed(1)}%)`);
console.log(`Buy fills:             ${buys.cnt} fills, $${Number(buys.n).toFixed(2)} deployed`);
console.log(`Sell fills:            ${sells.cnt} fills, $${Number(sells.n).toFixed(2)} returned`);

// 3. Proportion of leader's activity we captured
// Leader has $207K portfolio, our bot $50 = 0.024% scale
// Any 'per $1 invested' analysis
const leaderPortfolio = 207023.56;
const ourStarting = 50;
const scaleRatio = ourStarting / leaderPortfolio;
console.log(`\n=== SCALE COMPARISON ===`);
console.log(`Leader portfolio:      $${leaderPortfolio.toLocaleString()}`);
console.log(`Bot starting USDC:     $${ourStarting}`);
console.log(`Scale ratio:           ${(scaleRatio * 100).toFixed(4)}% of leader's size`);
console.log(`If bot copied ALL trades proportionally, expected P&L:`);
console.log(`  Leader P&L $1291.60 × ${(scaleRatio * 100).toFixed(4)}% = $${(1291.60 * scaleRatio).toFixed(2)}`);
console.log(`  vs our actual P&L: $${pnl.toFixed(2)}`);

// 4. Missed trade analysis — how much BUY notional did we skip due to MAX_OPEN_MARKETS?
const maxOpenSkips = db.prepare("SELECT COUNT(*) as cnt, COALESCE(SUM(desiredNotional), 0) as notional FROM CopyIntent WHERE profileId='leader2' AND status='SKIPPED' AND reason='MAX_OPEN_MARKETS'").get();
console.log(`\n=== MISSED TRADES ===`);
console.log(`MAX_OPEN_MARKETS skips: ${maxOpenSkips.cnt} events`);
console.log(`(desired notional was $0 for these — priced before quote)`);

// 5. Timeline: first fill vs last fill
const timeline = db.prepare("SELECT MIN(ts) as first, MAX(ts) as last FROM Fill WHERE profileId='leader2'").get();
const firstFill = new Date(Number(timeline.first));
const lastFill = new Date(Number(timeline.last));
const durationHours = (Number(timeline.last) - Number(timeline.first)) / 1000 / 3600;
console.log(`\n=== TIMELINE ===`);
console.log(`First fill:  ${firstFill.toISOString()}`);
console.log(`Last fill:   ${lastFill.toISOString()}`);
console.log(`Duration:    ${durationHours.toFixed(1)} hours active`);
console.log(`Trade rate:  ${(fills => fills / durationHours)(buys.cnt + sells.cnt).toFixed(1)} fills/hour`);

db.close();
