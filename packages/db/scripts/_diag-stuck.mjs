import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync("./prisma/dev.db");

// 1. Last fill timestamps per profile
const lastFills = db.prepare(`
  SELECT profileId, MAX(ts) as lastFill, COUNT(*) as total
  FROM Fill GROUP BY profileId
`).all();
console.log("=== LAST FILL PER PROFILE ===");
for (const r of lastFills) console.log(`  ${r.profileId}: lastFill=${r.lastFill}  total=${r.total}`);

// 2. Most recent leader events (last 20)
console.log("\n=== LAST 20 LEADER EVENTS ===");
const recentEvents = db.prepare(`
  SELECT profileId, ts, side, price, tokenId, conditionId
  FROM LeaderEvent ORDER BY ts DESC LIMIT 20
`).all();
for (const r of recentEvents) console.log(`  ${r.profileId} ${r.ts} ${r.side} price=${r.price} tokenId=${r.tokenId?.slice(0,12)}...`);

// 3. Most recent intents (last 30) — look for SKIPPED reasons
console.log("\n=== LAST 30 INTENTS (most recent first) ===");
const recentIntents = db.prepare(`
  SELECT profileId, ts, side, status, reason, desiredNotional, desiredSize
  FROM CopyIntent ORDER BY ts DESC LIMIT 30
`).all();
for (const r of recentIntents) {
  const reason = r.reason ? ` reason="${r.reason}"` : "";
  console.log(`  ${r.profileId} ${r.ts} ${r.side} ${r.status} notional=$${Number(r.desiredNotional).toFixed(2)}${reason}`);
}

// 4. SKIPPED reason breakdown (all time)
console.log("\n=== SKIPPED REASON BREAKDOWN ===");
const skipReasons = db.prepare(`
  SELECT profileId, reason, COUNT(*) as cnt
  FROM CopyIntent WHERE status='SKIPPED'
  GROUP BY profileId, reason ORDER BY profileId, cnt DESC
`).all();
for (const r of skipReasons) console.log(`  ${r.profileId}: "${r.reason}" × ${r.cnt}`);

// 5. Recent alerts
console.log("\n=== RECENT ALERTS (last 20) ===");
const alerts = db.prepare(`
  SELECT profileId, ts, type, message FROM Alert ORDER BY ts DESC LIMIT 20
`).all();
for (const r of alerts) console.log(`  ${r.profileId} ${r.ts} [${r.type}] ${r.message}`);

// 6. Runtime metrics
console.log("\n=== RUNTIME METRICS ===");
const metrics = db.prepare(`
  SELECT profileId, key, value, updatedAt FROM RuntimeMetric ORDER BY profileId, key
`).all();
for (const r of metrics) console.log(`  ${r.profileId} ${r.key}=${r.value}  updated=${r.updatedAt}`);

// 7. LeaderCursor (what event position are we at)
console.log("\n=== LEADER CURSORS ===");
const cursors = db.prepare(`SELECT * FROM LeaderCursor`).all();
for (const r of cursors) console.log(`  ${r.profileId} wallet=${r.leaderWallet?.slice(0,14)}... lastSeenActivityKey=${r.lastSeenActivityKey}  updatedAt=${r.updatedAt}`);

db.close();
