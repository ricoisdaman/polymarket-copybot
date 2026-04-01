import { PrismaClient } from "@prisma/client";
process.env.DATABASE_URL ??= "file:./prisma/dev.db";
const p = new PrismaClient();

// Count intents by status
const byStatus = await p.copyIntent.groupBy({
  by: ["status"],
  _count: { id: true },
  orderBy: { _count: { id: "desc" } },
});

// Count intents by skip reason (for SKIPPED ones)
const byReason = await p.copyIntent.groupBy({
  by: ["reason"],
  where: { status: "SKIPPED" },
  _count: { id: true },
  orderBy: { _count: { id: "desc" } },
});

// Recent skipped intents (last 20)
const recentSkipped = await p.copyIntent.findMany({
  where: { status: "SKIPPED" },
  orderBy: { ts: "desc" },
  take: 20,
  select: { ts: true, tokenId: true, side: true, reason: true, desiredNotional: true },
});

// Any FAILED intents
const failedReasons = await p.copyIntent.groupBy({
  by: ["reason"],
  where: { status: "FAILED" },
  _count: { id: true },
  orderBy: { _count: { id: "desc" } },
});

console.log("\n=== INTENTS BY STATUS ===");
for (const row of byStatus) console.log(` ${row.status}: ${row._count.id}`);

console.log("\n=== SKIP REASONS (top reasons) ===");
for (const row of byReason) console.log(` [${row._count.id}x] ${row.reason}`);

console.log("\n=== FAIL REASONS ===");
for (const row of failedReasons) console.log(` [${row._count.id}x] ${row.reason}`);

console.log("\n=== RECENT SKIPPED (last 20) ===");
for (const row of recentSkipped) {
  console.log(` ${new Date(row.ts).toISOString().slice(11,19)} | ${row.side} | ${row.tokenId.slice(0,16)}... | $${row.desiredNotional?.toFixed(2)} | ${row.reason}`);
}

await p.$disconnect();
