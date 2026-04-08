import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();

const fills = await p.fill.count();
const intents = await p.copyIntent.count();
const metrics = await p.runtimeMetric.count();
const configs = await p.configVersion.count();
const alerts = await p.alert.count();
console.log(`fills:${fills} intents:${intents} metrics:${metrics} configs:${configs} alerts:${alerts}`);

// All distinct profileIds
const profiles = await p.copyIntent.groupBy({ by: ['profileId'], _count: true });
console.log('Profiles in CopyIntent:', JSON.stringify(profiles.map(p => `${p.profileId}(${p._count})`)));

const mProfiles = await p.runtimeMetric.groupBy({ by: ['profileId'], _count: true });
console.log('Profiles in RuntimeMetric:', JSON.stringify(mProfiles.map(p => `${p.profileId}(${p._count})`)));

const cProfiles = await p.configVersion.groupBy({ by: ['profileId'], _count: true });
console.log('Profiles in ConfigVersion:', JSON.stringify(cProfiles.map(p => `${p.profileId}(${p._count})`)));

// Most recent records
const latestFill = await p.fill.findFirst({ orderBy: { ts: 'desc' }, select: { ts: true, profileId: true } });
const latestIntent = await p.copyIntent.findFirst({ orderBy: { ts: 'desc' }, select: { ts: true, profileId: true, status: true } });
console.log('Latest fill:', latestFill?.ts, latestFill?.profileId);
console.log('Latest intent:', latestIntent?.ts, latestIntent?.profileId, latestIntent?.status);

await p.$disconnect();
