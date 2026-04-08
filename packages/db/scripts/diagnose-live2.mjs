/**
 * Direct DB diagnostic using Prisma from the db package
 */
const { PrismaClient } = await import('@prisma/client');
const p = new PrismaClient();

const now = Date.now();
const h12 = new Date(now - 12 * 60 * 60 * 1000);
const h24 = new Date(now - 24 * 60 * 60 * 1000);
const h48 = new Date(now - 48 * 60 * 60 * 1000);

function sep(label) {
  console.log('\n' + '═'.repeat(72));
  console.log('  ' + label);
  console.log('═'.repeat(72));
}

// 1. Active config (contains paused/kill state as stored in ConfigVersion)
sep('1. ACTIVE CONFIG / RUNTIME STATE');
const configs = await p.configVersion.findMany({
  where: { active: true },
  select: { profileId: true, json: true, createdAt: true }
});
configs.forEach(c => {
  const cfg = JSON.parse(c.json);
  const b = cfg.budget || {};
  const f = cfg.filters || {};
  const rt = cfg.runtime || {};
  console.log(`  ${c.profileId.padEnd(14)} drawdown=$${b.maxDailyDrawdownUSDC}  minP=${f.minPrice}  maxP=${f.maxPrice}  paused=${rt.paused}  kill=${rt.killSwitch}  updated=${c.createdAt}`);
});

// 2. Recent fills (24h, all profiles)
sep('2. FILLS — last 24h');
const fills = await p.fill.findMany({
  where: { ts: { gt: h24 } },
  orderBy: { ts: 'desc' },
  take: 50,
  select: { profileId: true, price: true, size: true, ts: true, orderId: true }
});
if (fills.length === 0) {
  console.log('  No fills in last 24h');
} else {
  fills.forEach(f => {
    const t = new Date(f.ts).toLocaleString('en-GB');
    console.log(`  ${t}  ${f.profileId.padEnd(14)} price=${Number(f.price).toFixed(3)}  size=${f.size}`);
  });
}

// 3. Alerts (24h)
sep('3. ALERTS — last 24h');
const alerts = await p.alert.findMany({
  where: { ts: { gt: h24 } },
  orderBy: { ts: 'desc' },
  take: 30
});
if (alerts.length === 0) {
  console.log('  No alerts');
} else {
  alerts.forEach(a => {
    const t = new Date(a.ts).toLocaleString('en-GB');
    console.log(`  ${t}  ${(a.profileId||'').padEnd(14)} [${a.severity}] ${a.code}: ${a.message}`);
  });
}

// 4. Skip reason counts (live, 24h)
sep('4. SKIP REASONS — live, last 24h');
const skips = await p.copyIntent.groupBy({
  by: ['reason'],
  where: { profileId: 'live', status: 'SKIPPED', ts: { gt: h24 } },
  _count: true,
  orderBy: { _count: { reason: 'desc' } }
});
skips.forEach(s => console.log(`  ${(s.reason || '(null)').padEnd(30)} ${s._count}`));

// 5. Recent PAUSED/DRAWDOWN skips with timestamps (live, 24h)
sep('5. PAUSE-TYPE SKIPS with timestamps — live, last 24h');
const pauseSkips = await p.copyIntent.findMany({
  where: {
    profileId: 'live',
    status: 'SKIPPED',
    reason: { in: ['PAUSED', 'DRAWDOWN_STOP', 'KILL_SWITCH'] },
    ts: { gt: h24 }
  },
  orderBy: { ts: 'desc' },
  take: 30,
  select: { reason: true, ts: true }
});
if (pauseSkips.length === 0) {
  console.log('  None');
} else {
  pauseSkips.forEach(s => console.log(`  ${new Date(s.ts).toLocaleString('en-GB').padEnd(25)} ${s.reason}`));
}

// 6. Last 10 FILLED intents (live, 48h)
sep('6. LAST FILLED INTENTS — live, last 48h');
const lastFilled = await p.copyIntent.findMany({
  where: { profileId: 'live', status: 'FILLED', ts: { gt: h48 } },
  orderBy: { ts: 'desc' },
  take: 10,
  select: { ts: true, desiredNotional: true, desiredSize: true }
});
lastFilled.forEach(f => console.log(`  ${new Date(f.ts).toLocaleString('en-GB').padEnd(25)}  notional=$${Number(f.desiredNotional).toFixed(2)}  size=${f.desiredSize}`));

// 7. Metrics (live)
sep('7. RUNTIME METRICS — live');
const metrics = await p.runtimeMetric.findMany({ where: { profileId: 'live' } });
metrics.forEach(m => {
  const age = m.updatedAt ? Math.round((now - new Date(m.updatedAt).getTime()) / 1000) : null;
  console.log(`  ${m.key.padEnd(35)} = ${m.value}  (${age}s ago)`);
});

// 8. paper-v2 and paper-v3 heartbeat check
sep('8. PAPER-V2 / PAPER-V3 STATUS');
for (const pid of ['paper-v2', 'paper-v3']) {
  const hb = await p.runtimeMetric.findFirst({ where: { profileId: pid, key: 'bot.heartbeat_ts' } });
  const fills24 = await p.fill.count({ where: { profileId: pid, ts: { gt: h24 } } });
  const skips24 = await p.copyIntent.count({ where: { profileId: pid, status: 'SKIPPED', ts: { gt: h24 } } });
  const intents24 = await p.copyIntent.count({ where: { profileId: pid, ts: { gt: h24 } } });
  const hbAge = hb ? Math.round((now - new Date(hb.value).getTime()) / 1000) : null;
  const hbStr = hbAge === null ? 'NO HEARTBEAT' : `${Math.round(hbAge/60)}m ago`;
  console.log(`  ${pid}: heartbeat=${hbStr}  fills24h=${fills24}  intents24h=${intents24}  skips24h=${skips24}`);
}

await p.$disconnect();
console.log('\n✔ Done');
