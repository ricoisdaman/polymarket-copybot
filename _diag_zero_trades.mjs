import { PrismaClient } from "@prisma/client";
import path from "path";

const dbPath = path.resolve(process.cwd(), "packages/db/prisma/dev.db");
process.env.DATABASE_URL = "file:" + dbPath.replace(/\\/g, "/");

const prisma = new PrismaClient();
const now = Date.now();
const since24h = new Date(now - 24 * 60 * 60 * 1000);
const since8h = new Date(now - 8 * 60 * 60 * 1000);

async function main() {
  // 1. Skip reason breakdown per profile (last 24h)
  console.log("\n=== SKIP REASONS per profile (last 24h) ===");
  const skips = await prisma.copyIntent.groupBy({
    by: ["profileId", "reason"],
    where: { status: "SKIPPED", ts: { gte: since24h } },
    _count: { _all: true },
    orderBy: [{ profileId: "asc" }, { _count: { reason: "desc" } }]
  });
  console.table(skips.map(r => ({ profileId: r.profileId, reason: r.reason, cnt: r._count._all })));

  // 2. Actual trades per profile (last 24h)
  console.log("\n=== ACTUAL TRADES per profile (last 24h) ===");
  const trades = await prisma.copyIntent.groupBy({
    by: ["profileId", "status"],
    where: { status: { in: ["FILLED", "PARTIALLY_FILLED_OK", "PLACED", "SETTLED"] }, ts: { gte: since24h } },
    _count: { _all: true },
    orderBy: { profileId: "asc" }
  });
  if (trades.length === 0) console.log("  (ZERO trades across all profiles in 24h)");
  else console.table(trades.map(r => ({ profileId: r.profileId, status: r.status, cnt: r._count._all })));

  // 3. Most recent intents across all profiles
  console.log("\n=== MOST RECENT INTENTS (all profiles, last 25) ===");
  const recentIntents = await prisma.copyIntent.findMany({
    where: { ts: { gte: since24h } },
    orderBy: { ts: "desc" },
    take: 25,
    select: { profileId: true, status: true, reason: true, side: true, ts: true, leaderEventId: true }
  });
  const leIds = recentIntents.map(i => i.leaderEventId).filter(Boolean);
  const leMap = new Map();
  if (leIds.length > 0) {
    const les = await prisma.leaderEvent.findMany({
      where: { id: { in: leIds } },
      select: { id: true, price: true, rawJson: true }
    });
    for (const le of les) {
      try { leMap.set(le.id, { price: le.price, slug: JSON.parse(le.rawJson).slug ?? "" }); } catch {}
    }
  }
  if (recentIntents.length === 0) console.log("  (no intents at all in 24h - bot may not be polling)");
  else console.table(recentIntents.map(i => {
    const le = leMap.get(i.leaderEventId) ?? { price: null, slug: "" };
    return { profileId: i.profileId, status: i.status, reason: i.reason ?? "", side: i.side, price: le.price, slug: (le.slug ?? "").slice(0, 40), ts: i.ts.toISOString().slice(11, 19) };
  }));

  // 4. Slug breakdown for SLUG_BLOCKED on live
  console.log("\n=== SLUG_BLOCKED slugs on 'live' (last 24h, top 20) ===");
  const blockedIntents = await prisma.copyIntent.findMany({
    where: { profileId: "live", reason: "SLUG_BLOCKED", ts: { gte: since24h } },
    select: { leaderEventId: true }
  });
  const bLeIds = [...new Set(blockedIntents.map(i => i.leaderEventId))];
  const slugCounts = new Map();
  if (bLeIds.length > 0) {
    const bles = await prisma.leaderEvent.findMany({
      where: { id: { in: bLeIds } },
      select: { rawJson: true }
    });
    for (const le of bles) {
      try {
        const slug = JSON.parse(le.rawJson).slug ?? "(no slug)";
        slugCounts.set(slug, (slugCounts.get(slug) ?? 0) + 1);
      } catch {}
    }
  }
  console.table([...slugCounts.entries()].sort((a,b)=>b[1]-a[1]).slice(0,20).map(([slug,cnt])=>({ slug, cnt })));

  // 5. Bot heartbeats
  console.log("\n=== BOT HEARTBEATS ===");
  const hbMetrics = await prisma.runtimeMetric.findMany({ where: { key: "bot.heartbeat_ts" } });
  if (hbMetrics.length === 0) console.log("  (no heartbeats found - are bots running?)");
  else console.table(hbMetrics.map(m => ({
    profileId: m.profileId,
    minutes_ago: ((now - Number(m.value)) / 60000).toFixed(1),
    last_beat: new Date(Number(m.value)).toISOString().slice(11, 19) + " UTC"
  })));

  // 6. Feed status
  console.log("\n=== FEED STATUS ===");
  const feedMetrics = await prisma.runtimeMetric.findMany({
    where: { key: { in: ["bot.mode", "bot.feed.mode", "bot.feed.events_seen", "bot.feed.last_error"] } },
    orderBy: [{ profileId: "asc" }, { key: "asc" }]
  });
  console.table(feedMetrics.map(m => ({ profileId: m.profileId, key: m.key, value: m.value })));

  // 7. Recent WARN/ERROR alerts
  console.log("\n=== RECENT ALERTS (last 8h, WARN/ERROR) ===");
  const alerts = await prisma.alert.findMany({
    where: { ts: { gte: since8h }, severity: { in: ["WARN", "ERROR"] } },
    orderBy: { ts: "desc" },
    take: 20,
    select: { profileId: true, severity: true, code: true, message: true, ts: true }
  });
  if (alerts.length === 0) console.log("  (no WARN/ERROR alerts in 8h)");
  else console.table(alerts.map(a => ({
    profileId: a.profileId, sev: a.severity, code: a.code,
    msg: a.message.slice(0,60), ts: a.ts.toISOString().slice(11,19)
  })));
}

main().catch(console.error).finally(() => prisma.$disconnect());
