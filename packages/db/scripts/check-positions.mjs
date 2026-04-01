import { PrismaClient } from "@prisma/client";
process.env.DATABASE_URL ??= "file:./prisma/dev.db";
const p = new PrismaClient();

const [positions, fills, intents, leaderEvents] = await Promise.all([
  p.position.findMany({ select: { tokenId: true, size: true, avgPrice: true } }),
  p.fill.count(),
  p.copyIntent.count(),
  p.leaderEvent.count(),
]);
console.log("Positions (" + positions.length + "):", positions.map(r => ({ tok: r.tokenId, size: r.size, avgPrice: r.avgPrice })));
console.log("Fills:", fills);
console.log("Intents:", intents);
console.log("LeaderEvents:", leaderEvents);
await p.$disconnect();
