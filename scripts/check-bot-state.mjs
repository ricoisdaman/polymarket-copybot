import { PrismaClient } from "@prisma/client";

const p = new PrismaClient({ datasources: { db: { url: "file:./prisma/dev.db" } } });

const [cv, alerts, metrics] = await Promise.all([
  p.configVersion.findFirst({ where: { active: true }, orderBy: { createdAt: "desc" }, select: { json: true, profileId: true, createdAt: true } }),
  p.alert.findMany({ orderBy: { ts: "desc" }, take: 20, select: { ts: true, severity: true, code: true, profileId: true } }),
  p.runtimeMetric.findMany({ where: { key: { in: ["bot.heartbeat_ts", "bot.cash_usdc", "bot.drawdown_usdc"] } }, select: { profileId: true, key: true, value: true, updatedAt: true } })
]);

const cfg = cv ? JSON.parse(cv.json) : null;
console.log("=== ACTIVE CONFIG ===");
console.log("  profileId:", cv?.profileId);
console.log("  killSwitch:", cfg?.safety?.killSwitch);
console.log("  paused:", cfg?.safety?.paused);
console.log("  createdAt:", cv?.createdAt);

console.log("\n=== RUNTIME METRICS ===");
for (const m of metrics) {
  const age = m.key === "bot.heartbeat_ts" ? ` (age: ${Math.round((Date.now() - Number(m.value)) / 1000)}s)` : "";
  console.log(`  [${m.profileId}] ${m.key} = ${m.value}${age}`);
}

console.log("\n=== RECENT ALERTS (newest first) ===");
for (const a of alerts) {
  console.log(`  ${new Date(a.ts).toISOString().slice(11, 19)}  ${a.severity.padEnd(5)}  ${a.code.padEnd(35)}  profile=${a.profileId}`);
}

await p.$disconnect();
