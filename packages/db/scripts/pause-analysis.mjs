/**
 * Pause pattern analysis — when did the bot get paused and why?
 */
import { PrismaClient } from '@prisma/client';
const dbPath = 'C:/Users/Rico/new-bot-GPT/packages/db/prisma/dev.db';
const p = new PrismaClient({ datasources: { db: { url: `file:${dbPath}` } } });

function sep(label) {
  console.log('\n' + '═'.repeat(72));
  console.log('  ' + label);
  console.log('═'.repeat(72));
}

const h72 = new Date(Date.now() - 72 * 60 * 60 * 1000);

// ── 1. All drawdown/pause alerts (72h) ────────────────────────────────────────
sep('1. DRAWDOWN / PAUSE ALERTS — last 72h');
const alerts = await p.alert.findMany({
  where: {
    profileId: 'live',
    ts: { gt: h72 },
    code: { in: ['DAILY_DRAWDOWN_STOP', 'PAUSED', 'ORDER_REJECTED', 'ORDER_FAILED', 'RISK_CHECK_FAILED'] }
  },
  orderBy: { ts: 'desc' },
  take: 30
});
if (alerts.length === 0) {
  console.log('  No relevant alerts');
} else {
  alerts.forEach(a => console.log(`  ${a.ts.toLocaleString('en-GB').padEnd(25)} [${a.severity}] ${a.code}: ${a.message}`));
}

// Also show ALL alerts in 72h
sep('2. ALL ALERTS (live, 72h)');
const allAlerts = await p.alert.findMany({
  where: { profileId: 'live', ts: { gt: h72 } },
  orderBy: { ts: 'desc' },
  take: 40
});
allAlerts.forEach(a => console.log(`  ${a.ts.toLocaleString('en-GB').padEnd(25)} [${a.severity}] ${a.code}: ${a.message.substring(0, 80)}`));

// ── 3. Hourly breakdown of PAUSED vs DRAWDOWN_STOP skips ─────────────────────
sep('3. HOURLY BREAKDOWN — PAUSED + DRAWDOWN_STOP skips (live, 72h)');
const pausedSkips = await p.copyIntent.findMany({
  where: {
    profileId: 'live',
    status: 'SKIPPED',
    reason: { in: ['PAUSED', 'DRAWDOWN_STOP'] },
    ts: { gt: h72 }
  },
  select: { reason: true, ts: true },
  orderBy: { ts: 'asc' }
});

// Group by hour
const hourly = new Map();
for (const s of pausedSkips) {
  const d = new Date(s.ts);
  const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:00`;
  if (!hourly.has(key)) hourly.set(key, { PAUSED: 0, DRAWDOWN_STOP: 0 });
  hourly.get(key)[s.reason]++;
}
for (const [hour, counts] of [...hourly].sort((a, b) => a[0].localeCompare(b[0]))) {
  const total = counts.PAUSED + counts.DRAWDOWN_STOP;
  if (total > 0) {
    console.log(`  ${hour}  PAUSED=${counts.PAUSED}  DRAWDOWN_STOP=${counts.DRAWDOWN_STOP}`);
  }
}

// ── 4. Timestamps when first PAUSED skip appears after a fill ─────────────────
sep('4. FILLS → timeline (live, 72h)');
const recentFills = await p.fill.findMany({
  where: { profileId: 'live', ts: { gt: h72 } },
  orderBy: { ts: 'desc' },
  take: 30,
  select: { ts: true, price: true, size: true }
});
recentFills.forEach(f => console.log(`  ${f.ts.toLocaleString('en-GB').padEnd(25)} BUY price=${Number(f.price).toFixed(3)} size=${f.size}`));

// ── 5. ConfigVersion changes (live, 72h) — when was paused set? ───────────────
sep('5. CONFIG VERSION HISTORY — live, 72h');
const cfgHistory = await p.configVersion.findMany({
  where: { profileId: 'live', createdAt: { gt: h72 } },
  orderBy: { createdAt: 'desc' },
  take: 10
});
cfgHistory.forEach(c => {
  const cfg = JSON.parse(c.json);
  const rt = cfg.runtime ?? {};
  const b = cfg.budget ?? {};
  console.log(`  ${c.createdAt.toLocaleString('en-GB').padEnd(25)} active=${c.active}  paused=${rt.paused}  kill=${rt.killSwitch}  drawdown=$${b.maxDailyDrawdownUSDC}`);
});

// ── 6. Guardian worker alerts for live ────────────────────────────────────────
sep('6. ALL PROFILES ALERTS (72h) — guardian/pause events');
const guardianAlerts = await p.alert.findMany({
  where: { ts: { gt: h72 } },
  orderBy: { ts: 'desc' },
  take: 30
});
guardianAlerts.forEach(a => console.log(`  ${a.ts.toLocaleString('en-GB').padEnd(25)} ${(a.profileId||'').padEnd(14)} [${a.severity}] ${a.code}: ${a.message.substring(0, 60)}`));

await p.$disconnect();
console.log('\n✔ Done');
