// Diagnose why live profile shows 0% win rate
import { PrismaClient } from "./packages/db/node_modules/@prisma/client/index.js";
import path from "path";
import { fileURLToPath } from "url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbUrl = "file:" + path.resolve(__dirname, "./packages/db/prisma/dev.db").replace(/\\/g, "/");
const prisma = new PrismaClient({ datasources: { db: { url: dbUrl } } });

// Check SELL intents per profile
const sellIntents = await prisma.copyIntent.groupBy({
  by: ["profileId", "side"], _count: { id: true }
});
console.log("CopyIntent counts by profileId/side:");
console.table(sellIntents.map(r => ({ profileId: r.profileId, side: r.side, count: r._count.id })));

// Check positions resolved vs open
const positions = await prisma.$queryRawUnsafe(`
  SELECT profileId,
    SUM(CASE WHEN size <= 0.01 THEN 1 ELSE 0 END) as resolved,
    SUM(CASE WHEN size > 0.01 THEN 1 ELSE 0 END) as open
  FROM Position GROUP BY profileId
`);
console.log("\nPositions (size<=0.01=resolved, >0.01=open) per profile:");
console.table(positions);

// Check order sides for live and paper-v2
for (const prof of ["live", "paper-v2"]) {
  const orders = await prisma.$queryRawUnsafe(`
    SELECT side, status, COUNT(*) as count FROM "Order" WHERE profileId='${prof}' GROUP BY side, status ORDER BY side, status
  `);
  console.log(`\nOrders for [${prof}] by side/status:`);
  console.table(orders);
}

// Sample a few live SELL fills to see if they have real proceeds
const liveSells = await prisma.$queryRawUnsafe(`
  SELECT f.price, f.size, ROUND(f.price*f.size,3) as proceeds, o.side, ci.tokenId
  FROM Fill f
  JOIN "Order" o ON f.orderId = o.id
  JOIN CopyIntent ci ON o.intentId = ci.id
  WHERE ci.profileId = 'live' AND o.side = 'SELL'
  LIMIT 10
`);
console.log("\nSample live SELL fills:");
console.table(liveSells);

// Count all fills per profile+side
const fillCounts = await prisma.$queryRawUnsafe(`
  SELECT ci.profileId, o.side, COUNT(f.id) as fills
  FROM Fill f
  JOIN "Order" o ON f.orderId = o.id
  JOIN CopyIntent ci ON o.intentId = ci.id
  GROUP BY ci.profileId, o.side
  ORDER BY ci.profileId, o.side
`);
console.log("\nFill counts per profile and side:");
console.table(fillCounts);

await prisma.$disconnect();
