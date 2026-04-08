import { PrismaClient } from '@prisma/client';

// Use absolute path explicitly
const dbPath = 'C:/Users/Rico/new-bot-GPT/packages/db/prisma/dev.db';
const p = new PrismaClient({
  datasources: { db: { url: `file:${dbPath}` } }
});

const fills = await p.fill.count();
const intents = await p.copyIntent.count();
console.log(`fills:${fills} intents:${intents}`);

if (intents > 0) {
  const profiles = await p.copyIntent.groupBy({ by: ['profileId'], _count: true });
  console.log('Profiles:', profiles.map(p => `${p.profileId}(${p._count})`).join(', '));
  const latest = await p.copyIntent.findFirst({ orderBy: { ts: 'desc' }, select: { ts: true, profileId: true, status: true } });
  console.log('Latest intent:', latest?.ts, latest?.profileId, latest?.status);
}

// Also check fills
if (fills > 0) {
  const latest = await p.fill.findFirst({ orderBy: { ts: 'desc' }, select: { ts: true, profileId: true } });
  console.log('Latest fill:', latest?.ts, latest?.profileId);
}

await p.$disconnect();
