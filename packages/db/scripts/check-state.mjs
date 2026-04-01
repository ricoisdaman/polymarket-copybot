import { PrismaClient } from "@prisma/client";
const db = new PrismaClient();

// --- Runtime control state (lives inside ConfigVersion JSON) ---
const activeConfig = await db.configVersion.findFirst({
  where: { active: true },
  orderBy: { createdAt: "desc" },
});
const cfg = activeConfig ? JSON.parse(activeConfig.json) : null;
console.log("\n=== Runtime Control (from active ConfigVersion) ===");
if (cfg) {
  console.log("  paused:     ", cfg.safety?.paused);
  console.log("  killSwitch: ", cfg.safety?.killSwitch);
  console.log("  updatedAt:  ", new Date(activeConfig.createdAt).toLocaleString());
} else {
  console.log("  (no active config version found)");
}

// --- Most recent KILL_SWITCH skips ---
const recentKill = await db.copyIntent.findMany({
  where: { reason: "KILL_SWITCH" },
  orderBy: { ts: "desc" },
  take: 10,
});
console.log("\n=== Most recent KILL_SWITCH skips ===");
if (recentKill.length === 0) {
  console.log("  (none)");
} else {
  for (const i of recentKill)
    console.log(" ", new Date(i.ts).toLocaleTimeString(), i.side, i.tokenId.slice(0, 20));
  const oldest = new Date(recentKill.at(-1).ts);
  const newest = new Date(recentKill[0].ts);
  console.log(`  range: ${oldest.toLocaleTimeString()} -> ${newest.toLocaleTimeString()}`);
}

// --- Most recent non-SKIPPED intents ---
const recentOk = await db.copyIntent.findMany({
  where: { status: { not: "SKIPPED" } },
  orderBy: { ts: "desc" },
  take: 5,
});
console.log("\n=== Most recent non-SKIPPED intents ===");
if (recentOk.length === 0) {
  console.log("  (none)");
} else {
  for (const i of recentOk)
    console.log(" ", new Date(i.ts).toLocaleTimeString(), i.status, i.side, i.reason ?? "");
}

// --- Bot heartbeat ---
const heartbeat = await db.runtimeMetric.findFirst({ where: { key: "bot.heartbeat_ts" } });
const feedEvents = await db.runtimeMetric.findFirst({ where: { key: "bot.feed.events_seen" } });
const feedError = await db.runtimeMetric.findFirst({ where: { key: "bot.feed.last_error" } });
console.log("\n=== Bot Metrics ===");
if (heartbeat?.value) {
  const ageMs = Date.now() - Number(heartbeat.value);
  console.log("  heartbeat age:", Math.round(ageMs / 1000) + "s", ageMs > 30000 ? "<-- STALE!" : "(OK)");
} else {
  console.log("  heartbeat: (no entry -- bot-worker never ran or metrics table empty)");
}
console.log("  events seen:     ", feedEvents?.value ?? "(none)");
console.log("  last feed error: ", feedError?.value || "(none)");

// --- Recent ERROR alerts ---
const errors = await db.alert.findMany({
  where: { severity: "ERROR" },
  orderBy: { ts: "desc" },
  take: 10,
});
console.log("\n=== Recent ERROR alerts ===");
if (errors.length === 0) {
  console.log("  (none)");
} else {
  for (const a of errors)
    console.log(" ", new Date(a.ts).toLocaleString(), a.code, "-", a.message.slice(0, 80));
}

await db.$disconnect();
