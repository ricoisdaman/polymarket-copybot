import { PrismaClient } from '@prisma/client';
const dbPath = 'C:/Users/Rico/new-bot-GPT/packages/db/prisma/dev.db';
const p = new PrismaClient({ datasources: { db: { url: `file:${dbPath}` } } });

// Live profile detail
const liveLatest = await p.copyIntent.findFirst({
  where: { profileId: 'live' },
  orderBy: { ts: 'desc' },
  select: { ts: true, status: true, reason: true }
});
const liveCount = await p.copyIntent.count({ where: { profileId: 'live' } });
console.log(`live: count=${liveCount}, latest=${liveLatest?.ts?.toISOString()} ${liveLatest?.status} ${liveLatest?.reason ?? ''}`);

// Live fills
const liveFills = await p.fill.count({ where: { profileId: 'live' } });
const latestLiveFill = await p.fill.findFirst({ where: { profileId: 'live' }, orderBy: { ts: 'desc' }, select: { ts: true } });
console.log(`live fills: ${liveFills}, latest fill: ${latestLiveFill?.ts?.toISOString() ?? 'none'}`);

// Live metrics
const liveMetrics = await p.runtimeMetric.findMany({ where: { profileId: 'live' } });
console.log('live metrics:');
liveMetrics.forEach(m => console.log(`  ${m.key} = ${m.value?.substring(0, 60)} (updated: ${m.updatedAt?.toISOString()})`));

// Live active config
const liveCfg = await p.configVersion.findFirst({ where: { profileId: 'live', active: true }, orderBy: { createdAt: 'desc' } });
if (liveCfg) {
  const cfg = JSON.parse(liveCfg.json);
  console.log(`live config: drawdown=$${cfg.budget?.maxDailyDrawdownUSDC} minP=${cfg.filters?.minPrice} maxP=${cfg.filters?.maxPrice} paused=${JSON.stringify(cfg.runtime?.paused)}`);
}

// Skip reasons live last 24h
const h24 = new Date(Date.now() - 24 * 60 * 60 * 1000);
const skipReasons = await p.copyIntent.groupBy({
  by: ['reason'],
  where: { profileId: 'live', status: 'SKIPPED', ts: { gt: h24 } },
  _count: true
});
console.log('\nSkip reasons (live, 24h):');
skipReasons.sort((a, b) => b._count - a._count).forEach(s => console.log(`  ${(s.reason || 'null').padEnd(30)} ${s._count}`));

// Pause-type skips with timestamps (live, last 24h)
const pauseSkips = await p.copyIntent.findMany({
  where: { profileId: 'live', status: 'SKIPPED', reason: { in: ['PAUSED', 'DRAWDOWN_STOP', 'KILL_SWITCH'] }, ts: { gt: h24 } },
  orderBy: { ts: 'desc' },
  take: 20,
  select: { reason: true, ts: true }
});
console.log(`\nPause-type skips (live, 24h): ${pauseSkips.length}`);
pauseSkips.slice(0, 10).forEach(s => console.log(`  ${s.ts.toLocaleString('en-GB').padEnd(25)} ${s.reason}`));

await p.$disconnect();
