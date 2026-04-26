// Health check: verify SLUG_BLOCKED is firing, trades executing, no errors
// Looks at the last ~8 hours for profile "live"

import { PrismaClient } from "@prisma/client";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
process.env.DATABASE_URL = `file:${path.join(__dirname, "packages/db/prisma/dev.db")}`;

const prisma = new PrismaClient();

const PROFILE = "live";
const HOURS = 10; // look back 10h to be safe
const since = new Date(Date.now() - HOURS * 60 * 60 * 1000);

// ── 1. CopyIntent summary ─────────────────────────────────────────────────
const allIntents = await prisma.copyIntent.findMany({
  where: { profileId: PROFILE, ts: { gte: since } },
  orderBy: { ts: "asc" },
});

const byStatus = {};
const byReason = {};
for (const i of allIntents) {
  byStatus[i.status] = (byStatus[i.status] ?? 0) + 1;
  if (i.reason) byReason[i.reason] = (byReason[i.reason] ?? 0) + 1;
}

console.log(`\n=== CopyIntents last ${HOURS}h (profile: ${PROFILE}) ===`);
console.log(`Total: ${allIntents.length}`);
console.log("By status:", byStatus);
console.log("By skip reason (where skipped):", byReason);

// ── 2. SLUG_BLOCKED detail ────────────────────────────────────────────────
const slugBlocked = allIntents.filter((i) => i.reason === "SLUG_BLOCKED");
console.log(`\n=== SLUG_BLOCKED trades (${slugBlocked.length}) ===`);
if (slugBlocked.length === 0) {
  console.log("  ⚠  None fired — either no tennis events came in, or the build wasn't picked up.");
} else {
  for (const i of slugBlocked) {
    // Pull the LeaderEvent to show what was blocked
    const ev = await prisma.leaderEvent.findUnique({ where: { id: i.leaderEventId } });
    let slug = "?";
    if (ev?.rawJson) {
      try {
        const raw = JSON.parse(ev.rawJson);
        slug = raw.slug ?? raw.eventSlug ?? "no-slug";
      } catch {}
    }
    const ts = new Date(i.ts).toISOString().slice(0, 19);
    console.log(`  ${ts}  slug=${slug}  tokenId=${i.tokenId.slice(0, 12)}…`);
  }
}

// ── 3. TITLE_BLOCKED detail ───────────────────────────────────────────────
const titleBlocked = allIntents.filter((i) => i.reason === "TITLE_BLOCKED");
console.log(`\n=== TITLE_BLOCKED trades (${titleBlocked.length}) ===`);
for (const i of titleBlocked) {
  const ev = await prisma.leaderEvent.findUnique({ where: { id: i.leaderEventId } });
  let title = "?";
  if (ev?.rawJson) {
    try { title = JSON.parse(ev.rawJson).title ?? "?"; } catch {}
  }
  const ts = new Date(i.ts).toISOString().slice(0, 19);
  console.log(`  ${ts}  "${title}"`);
}

// ── 4. Executed trades ────────────────────────────────────────────────────
const executed = allIntents.filter((i) => i.status === "FILLED" || i.status === "PLACED" || i.status === "OPEN");
console.log(`\n=== Executed / Open intents (${executed.length}) ===`);
for (const i of executed) {
  const ev = await prisma.leaderEvent.findUnique({ where: { id: i.leaderEventId } });
  let slug = "?";
  if (ev?.rawJson) {
    try {
      const raw = JSON.parse(ev.rawJson);
      slug = raw.slug ?? raw.eventSlug ?? "no-slug";
    } catch {}
  }
  const ts = new Date(i.ts).toISOString().slice(0, 19);
  console.log(`  ${ts}  ${i.side.padEnd(4)}  $${i.desiredNotional.toFixed(2)}  slug=${slug}  status=${i.status}`);
}

// ── 5. Any ERROR status intents ───────────────────────────────────────────
const errors = allIntents.filter((i) => i.status === "ERROR" || i.status === "FAILED");
console.log(`\n=== ERROR/FAILED intents (${errors.length}) ===`);
for (const i of errors) {
  const ts = new Date(i.ts).toISOString().slice(0, 19);
  console.log(`  ${ts}  reason=${i.reason}  tokenId=${i.tokenId.slice(0, 12)}…`);
}

// ── 6. Recent fills ───────────────────────────────────────────────────────
const recentOrders = await prisma.order.findMany({
  where: { profileId: PROFILE, ts: { gte: since } },
  select: { id: true, ts: true, side: true, price: true, size: true, status: true },
  orderBy: { ts: "desc" },
  take: 20,
});
console.log(`\n=== Recent orders last ${HOURS}h (${recentOrders.length} shown, max 20) ===`);
for (const o of recentOrders) {
  const ts = new Date(o.ts).toISOString().slice(0, 19);
  const notional = (o.price * o.size).toFixed(2);
  console.log(`  ${ts}  ${o.side.padEnd(4)}  price=${o.price.toFixed(3)}  shares=${o.size.toFixed(1)}  ~$${notional}  ${o.status}`);
}

// ── 7. Leader events seen (sanity: is bot still polling?) ─────────────────
const recentLeaderEvents = await prisma.leaderEvent.findMany({
  where: { profileId: PROFILE, ts: { gte: since } },
  orderBy: { ts: "desc" },
  take: 5,
  select: { ts: true, side: true, price: true, usdcSize: true, rawJson: true },
});
console.log(`\n=== Last 5 leader events seen ===`);
if (recentLeaderEvents.length === 0) {
  console.log("  ⚠  No leader events in last 10h — bot may not be polling.");
} else {
  for (const e of recentLeaderEvents) {
    let slug = "?";
    try { slug = JSON.parse(e.rawJson).slug ?? "?"; } catch {}
    const ts = new Date(e.ts).toISOString().slice(0, 19);
    console.log(`  ${ts}  ${e.side.padEnd(4)}  price=${e.price.toFixed(3)}  $${e.usdcSize.toFixed(2)}  slug=${slug}`);
  }
}

await prisma.$disconnect();
