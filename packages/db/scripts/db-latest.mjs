import { PrismaClient } from '@prisma/client';

// Use absolute path explicitly
const dbPath = 'C:/Users/Rico/new-bot-GPT/packages/db/prisma/dev.db';
const p = new PrismaClient({
  datasources: { db: { url: `file:${dbPath}` } }
});

// Most recent intent per profile
const profiles = ['live', 'paper-v2', 'paper-v3', 'paper-sports-b'];
for (const pid of profiles) {
  const latest = await p.copyIntent.findFirst({
    where: { profileId: pid },
    orderBy: { ts: 'desc' },
    select: { ts: true, status: true, reason: true }
  });
  const count = await p.copyIntent.count({ where: { profileId: pid } });
  console.log(`${pid.padEnd(15)}: count=${count}, latest=${latest?.ts?.toISOString() ?? 'none'} ${latest?.status ?? ''}`);
}

// Most recent fill
const latestFill = await p.fill.findFirst({ orderBy: { ts: 'desc' }, select: { ts: true, profileId: true } });
const latestMetric = await p.runtimeMetric.findFirst({ orderBy: { updatedAt: 'desc' }, select: { updatedAt: true, profileId: true, key: true, value: true } });
const latestConfig = await p.configVersion.findFirst({ orderBy: { createdAt: 'desc' }, select: { createdAt: true, profileId: true, active: true } });

console.log('\nLatest fill:', latestFill?.ts?.toISOString(), latestFill?.profileId);
console.log('Latest metric:', latestMetric?.updatedAt?.toISOString(), latestMetric?.profileId, latestMetric?.key, '=', latestMetric?.value?.substring(0, 40));
console.log('Latest config:', latestConfig?.createdAt?.toISOString(), latestConfig?.profileId, 'active=', latestConfig?.active);

await p.$disconnect();
