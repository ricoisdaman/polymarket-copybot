import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();
const since = new Date(Date.now() - 30 * 60 * 1000);
const r = await p.copyIntent.groupBy({
  by: ['profileId', 'reason'],
  _count: { reason: true },
  where: { status: 'SKIPPED', ts: { gte: since } },
  orderBy: [{ profileId: 'asc' }]
});
for (const row of r) {
  console.log(`${row.profileId.padEnd(20)} ${String(row.reason).padEnd(40)} ${row._count.reason}`);
}

console.log('\n--- INSUFFICIENT_LIQUIDITY details (live, last 30m) ---');
const details = await p.copyIntent.findMany({
  where: { profileId: 'live', reason: 'INSUFFICIENT_LIQUIDITY', ts: { gte: since } },
  include: { leaderEvent: true },
  orderBy: { ts: 'desc' }
});
for (const row of details) {
  const ev = row.leaderEvent;
  console.log(`ts=${row.ts.toISOString()} side=${row.side} leaderSize=${row.leaderSize} desiredSize=${row.desiredSize}`);
  if (ev) console.log(`  event.price=${ev.price} event.size=${ev.size} title=${ev.raw?.title ?? ev.raw?.question ?? '?'}`);
}
await p.$disconnect();
