import { PrismaClient } from "@prisma/client";
const db = new PrismaClient();

// Open positions with size > 0
const positions = await db.position.findMany({ where: { size: { gt: 0 } } });
console.log(`\nOpen positions: ${positions.length}`);
for (const p of positions) {
  console.log(`  ${p.tokenId.slice(0, 20)}  size=${p.size.toFixed(4)}  avgPrice=${p.avgPrice.toFixed(4)}`);
}

// Recent MAX_OPEN_MARKETS skips
const skips = await db.copyIntent.findMany({
  where: { reason: "MAX_OPEN_MARKETS" },
  orderBy: { ts: "desc" },
  take: 10,
});
console.log(`\nRecent MAX_OPEN_MARKETS skips: ${skips.length} shown (total may be higher)`);
for (const s of skips) {
  console.log(`  ${new Date(s.ts).toLocaleTimeString()}  ${s.side}  ${s.tokenId.slice(0, 20)}`);
}

// Count total
const total = await db.copyIntent.count({ where: { reason: "MAX_OPEN_MARKETS" } });
console.log(`  Total MAX_OPEN_MARKETS skips all time: ${total}`);

// What the config limit is
const activeConfig = await db.configVersion.findFirst({ where: { active: true }, orderBy: { createdAt: "desc" } });
const cfg = activeConfig ? JSON.parse(activeConfig.json) : null;
console.log(`\nmaxOpenMarkets config: ${cfg?.budget?.maxOpenMarkets ?? "(not set)"}`);

await db.$disconnect();
