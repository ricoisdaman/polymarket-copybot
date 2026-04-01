import { PrismaClient } from "@prisma/client";
const dbUrl = process.env.DATABASE_URL ?? "file:./packages/db/prisma/dev.db";
const p = new PrismaClient({ datasources: { db: { url: dbUrl } } });

const [intents, fillCount, sellFills, positions] = await Promise.all([
  p.copyIntent.groupBy({ by: ["side", "status"], _count: true, where: { profileId: "default" } }),
  p.fill.count({ where: { profileId: "default" } }),
  p.fill.findMany({
    where: { profileId: "default" },
    take: 5,
    orderBy: { ts: "desc" },
    select: { id: true, price: true, size: true, ts: true, orderId: true }
  }),
  p.position.findMany({
    where: { profileId: "default" },
    select: { tokenId: true, size: true, avgPrice: true, updatedAt: true },
    orderBy: { updatedAt: "desc" }
  })
]);

console.log("\n=== INTENT COUNTS BY SIDE/STATUS ===");
console.log(JSON.stringify(intents, null, 2));
console.log("\n=== TOTAL FILLS IN DB:", fillCount, "===");
console.log("\n=== 5 MOST RECENT FILLS ===");
console.log(JSON.stringify(sellFills, null, 2));
console.log("\n=== ALL POSITIONS (size > 0 means open) ===");
for (const pos of positions) {
  console.log(`  tokenId: ...${pos.tokenId.slice(-10)}  size: ${pos.size}  avgPrice: ${pos.avgPrice}  updated: ${pos.updatedAt.toISOString()}`);
}

await p.$disconnect();
