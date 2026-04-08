// Quick probe: what does rawJson look like on LeaderEvent?
import { PrismaClient } from '@prisma/client';
const p = new PrismaClient({ datasources: { db: { url: 'file:C:/Users/Rico/new-bot-GPT/packages/db/prisma/dev.db' } } });

// Sample 10 recent events from live profile
const events = await p.leaderEvent.findMany({
  where: { profileId: 'live' },
  orderBy: { ts: 'desc' },
  take: 10,
  select: { ts: true, price: true, size: true, usdcSize: true, side: true, rawJson: true }
});

for (const e of events) {
  let raw = {};
  try { raw = JSON.parse(e.rawJson); } catch {}
  console.log('--- ts:', e.ts.toISOString(), 'side:', e.side, 'price:', e.price, 'size:', e.size, 'usdc:', e.usdcSize);
  console.log('  raw keys:', Object.keys(raw).join(', '));
  // Print key fields
  const title = raw.title ?? raw.question ?? raw.market_slug ?? raw.slug ?? raw.name ?? '(no title)';
  console.log('  title:', title);
  console.log('  tags:', JSON.stringify(raw.tags ?? raw.categories ?? raw.category ?? '(none)'));
  console.log('  startDate/endDate:', raw.startDate ?? raw.start_date ?? raw.gameStartTime ?? '-', '/', raw.endDate ?? raw.end_date ?? raw.endTime ?? '-');
  console.log('  full sample:', JSON.stringify(raw).slice(0, 400));
  console.log();
}

await p.$disconnect();
