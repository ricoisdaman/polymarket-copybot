/**
 * Cross-profile comparison: live vs paper-v2 vs paper-v3
 * Answers: are v2/v3 copying correctly? What has wider filter taught us?
 */
import { PrismaClient } from '@prisma/client';
const dbPath = 'C:/Users/Rico/new-bot-GPT/packages/db/prisma/dev.db';
const p = new PrismaClient({ datasources: { db: { url: `file:${dbPath}` } } });

function sep(label) {
  console.log('\n' + '═'.repeat(76));
  console.log('  ' + label);
  console.log('═'.repeat(76));
}
function pct(a, b) { return b === 0 ? 'n/a' : (a / b * 100).toFixed(1) + '%'; }
function fmt(n) { return (n >= 0 ? '+' : '') + Number(n).toFixed(4); }

const profiles = ['live', 'paper-v2', 'paper-v3'];

// Time windows — use a window since v2/v3 wider filters were applied (April 5 01:26)
const since = new Date('2026-04-05T01:26:00Z'); // after config changes were applied
const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

// ── 1. Active configs ─────────────────────────────────────────────────────────
sep('1. ACTIVE CONFIGS');
for (const pid of profiles) {
  const cfg = await p.configVersion.findFirst({ where: { profileId: pid, active: true }, orderBy: { createdAt: 'desc' } });
  if (!cfg) { console.log(`  ${pid}: no active config`); continue; }
  const c = JSON.parse(cfg.json);
  const b = c.budget ?? {}, f = c.filters ?? {};
  console.log(`  ${pid.padEnd(12)} drawdown=$${b.maxDailyDrawdownUSDC}  perTrade=$${b.perTradeNotionalUSDC}  filter=${f.minPrice}–${f.maxPrice}  dailyNotional=$${b.maxDailyNotionalUSDC}`);
}

// ── 2. Overall intent / fill counts (since config change) ────────────────────
sep('2. INTENT & FILL COUNTS — since v2/v3 wider filter applied (Apr 5 01:26 UTC)');
for (const pid of profiles) {
  const totalIntents  = await p.copyIntent.count({ where: { profileId: pid, ts: { gt: since } } });
  const filled        = await p.copyIntent.count({ where: { profileId: pid, status: 'FILLED', ts: { gt: since } } });
  const skipped       = await p.copyIntent.count({ where: { profileId: pid, status: 'SKIPPED', ts: { gt: since } } });
  const fills         = await p.fill.count({ where: { profileId: pid, ts: { gt: since } } });

  console.log(`  ${pid.padEnd(12)} intents=${totalIntents}  filled=${filled}(${pct(filled,totalIntents)})  skipped=${skipped}  fills=${fills}`);
}

// ── 3. Skip reason breakdown per profile ─────────────────────────────────────
sep('3. SKIP REASONS — since Apr 5 01:26 UTC');
for (const pid of profiles) {
  const skips = await p.copyIntent.groupBy({
    by: ['reason'],
    where: { profileId: pid, status: 'SKIPPED', ts: { gt: since } },
    _count: true
  });
  const total = skips.reduce((s, x) => s + x._count, 0);
  if (total === 0) { console.log(`  ${pid}: (no skips)`); continue; }
  console.log(`\n  ${pid} (${total} total skips):`);
  skips.sort((a,b) => b._count - a._count).forEach(s =>
    console.log(`    ${(s.reason ?? '(null)').padEnd(30)} ${String(s._count).padStart(5)}  (${pct(s._count, total)})`));
}

// ── 4. Fill price distribution per profile ────────────────────────────────────
sep('4. FILL PRICE DISTRIBUTION — since Apr 5 01:26 UTC');
for (const pid of profiles) {
  const fills = await p.fill.findMany({
    where: { profileId: pid, ts: { gt: since } },
    select: { price: true, ts: true }
  });
  if (fills.length === 0) { console.log(`  ${pid}: no fills`); continue; }

  const buckets = { '<50c': 0, '50-60c': 0, '60-70c': 0, '70-80c': 0, '80-88c': 0, '88-95c': 0, '>95c': 0 };
  for (const f of fills) {
    const pr = Number(f.price);
    if (pr < 0.50) buckets['<50c']++;
    else if (pr < 0.60) buckets['50-60c']++;
    else if (pr < 0.70) buckets['60-70c']++;
    else if (pr < 0.80) buckets['70-80c']++;
    else if (pr < 0.88) buckets['80-88c']++;
    else if (pr < 0.95) buckets['88-95c']++;
    else buckets['>95c']++;
  }
  const line = Object.entries(buckets).map(([k, v]) => `${k}:${v}`).join('  ');
  console.log(`  ${pid.padEnd(12)} total=${fills.length}  ${line}`);
}

// ── 5. P&L comparison ─────────────────────────────────────────────────────────
sep('5. REALIZED P&L — all time (from fills + position data)');
for (const pid of profiles) {
  // Get all fills
  const allFills = await p.fill.findMany({
    where: { profileId: pid },
    select: { price: true, size: true, fee: true, ts: true }
  });
  // Positions still open (unrealized)
  const openPositions = await p.position.findMany({
    where: { profileId: pid, size: { gt: 0 } }
  });
  // Cash metric
  const cashMetric = await p.runtimeMetric.findFirst({ where: { profileId: pid, key: 'bot.cash_usdc' } });
  const cash = cashMetric ? Number(cashMetric.value) : null;
  const costBasis = openPositions.reduce((s, pos) => s + Number(pos.size) * Number(pos.avgPrice), 0);
  const totalBought = allFills.reduce((s, f) => s + Number(f.price) * Number(f.size), 0);
  const totalFees = allFills.reduce((s, f) => s + Number(f.fee), 0);

  // Heartbeat age
  const hb = await p.runtimeMetric.findFirst({ where: { profileId: pid, key: 'bot.heartbeat_ts' } });
  const hbAge = hb ? Math.round((Date.now() - Number(hb.value)) / 1000) : null;
  const hbStr = hbAge === null ? 'OFFLINE' : hbAge < 120 ? `${hbAge}s ago (LIVE)` : `${Math.round(hbAge/60)}m ago (OFFLINE)`;

  console.log(`\n  ${pid}:`);
  console.log(`    Cash:      $${cash !== null ? cash.toFixed(4) : 'n/a'}  (heartbeat: ${hbStr})`);
  console.log(`    OpenPos:   ${openPositions.length} positions  costBasis=$${costBasis.toFixed(4)}`);
  console.log(`    TotalBought: $${totalBought.toFixed(2)}  Fees: $${totalFees.toFixed(4)}`);
  if (cash !== null) {
    const startingMetric = await p.runtimeMetric.findFirst({ where: { profileId: pid, key: 'bot.live_starting_usdc' } });
    const starting = startingMetric ? Number(startingMetric.value) : null;
    if (starting !== null) {
      const equity = cash + costBasis;
      const pnl = equity - starting;
      console.log(`    Starting:  $${starting}  →  Equity=$${equity.toFixed(4)}  PnL=${fmt(pnl)}`);
    }
  }
}

// ── 6. Leader events vs copy intents — are we seeing the same events? ─────────
sep('6. LEADER COVERAGE — did v2/v3 see the same leader events as live?');
// Count leader events per profile in the window
for (const pid of profiles) {
  const leaderEvents = await p.leaderEvent.count({ where: { profileId: pid, ts: { gt: since } } });
  const copyIntents  = await p.copyIntent.count({ where: { profileId: pid, ts: { gt: since } } });
  console.log(`  ${pid.padEnd(12)} leaderEvents=${leaderEvents}  copyIntents=${copyIntents}  coverage=${pct(copyIntents, leaderEvents)}`);
}

// ── 7. Fills unique to each profile (per dedupeKey) ───────────────────────────
sep('7. TRADE OVERLAP — which leader trades did each profile fill? (7d)');
// Get all filled intent dedupeKeys per profile
const leaderEventsByProfile = new Map();
for (const pid of profiles) {
  const filledIntents = await p.copyIntent.findMany({
    where: { profileId: pid, status: 'FILLED', ts: { gt: since7d } },
    select: { leaderEventId: true }
  });
  const ids = filledIntents.map(i => i.leaderEventId);
  // Get the dedupeKeys for those events
  const events = await p.leaderEvent.findMany({
    where: { profileId: pid, id: { in: ids } },
    select: { dedupeKey: true }
  });
  leaderEventsByProfile.set(pid, new Set(events.map(e => e.dedupeKey)));
}

const liveFilled     = leaderEventsByProfile.get('live') ?? new Set();
const v2Filled       = leaderEventsByProfile.get('paper-v2') ?? new Set();
const v3Filled       = leaderEventsByProfile.get('paper-v3') ?? new Set();

const allKeys = new Set([...liveFilled, ...v2Filled, ...v3Filled]);
let liveOnly = 0, v2Only = 0, v3Only = 0, allThree = 0, liveAndV2 = 0, liveAndV3 = 0;
for (const k of allKeys) {
  const inL = liveFilled.has(k), in2 = v2Filled.has(k), in3 = v3Filled.has(k);
  if (inL && in2 && in3) allThree++;
  else if (inL && in2) liveAndV2++;
  else if (inL && in3) liveAndV3++;
  else if (inL) liveOnly++;
  else if (in2) v2Only++;
  else if (in3) v3Only++;
}
console.log(`  Total unique filled trades (7d): ${allKeys.size}`);
console.log(`  All three filled:   ${allThree}`);
console.log(`  live + v2 only:     ${liveAndV2}`);
console.log(`  live + v3 only:     ${liveAndV3}`);
console.log(`  live only:          ${liveOnly}`);
console.log(`  v2 only:            ${v2Only}  ← new trades v2 catches that live doesn't`);
console.log(`  v3 only:            ${v3Only}  ← new trades v3 catches that live doesn't`);

// ── 8. v2/v3 fills OUTSIDE live filter (new trades from wider filter) ────────
sep('8. v2 EXTRA FILLS — trades in 60-88c band that live (70-80c) would miss');
const v2Fills = await p.fill.findMany({
  where: { profileId: 'paper-v2', ts: { gt: since7d } },
  select: { price: true, size: true, ts: true },
  orderBy: { ts: 'desc' }
});
const extraV2 = v2Fills.filter(f => {
  const pr = Number(f.price);
  return pr < 0.70 || pr > 0.80;
});
console.log(`  v2 fills outside live 70-80c window: ${extraV2.length} / ${v2Fills.length} total`);

// Need to calculate realized P&L for extra fills — approximate by position outcome
// For now show price distribution of extra trades
const extraBuckets = { '60-70c': 0, '80-88c': 0 };
for (const f of extraV2) {
  const pr = Number(f.price);
  if (pr >= 0.60 && pr < 0.70) extraBuckets['60-70c']++;
  else if (pr > 0.80 && pr <= 0.88) extraBuckets['80-88c']++;
}
console.log(`  Extra fills: 60-70c=${extraBuckets['60-70c']}  80-88c=${extraBuckets['80-88c']}`);

// ── 9. Why are v2/v3 missing trades compared to leader? ──────────────────────
sep('9. ARE v2/v3 PROCESSING ALL LEADER EVENTS?');
for (const pid of ['paper-v2', 'paper-v3']) {
  // Count leader events without any intent (events the bot saw but didn't act on OR didn't process)
  const leaderCount    = await p.leaderEvent.count({ where: { profileId: pid, ts: { gt: since } } });
  const intentCount    = await p.copyIntent.count({ where: { profileId: pid, ts: { gt: since } } });
  const unprocessed    = leaderCount - intentCount;

  // Check if paper bots are running (heartbeat)
  const hb = await p.runtimeMetric.findFirst({ where: { profileId: pid, key: 'bot.heartbeat_ts' } });
  const hbAge = hb ? Math.round((Date.now() - Number(hb.value)) / 60000) : null;
  const online = hbAge !== null && hbAge < 5;

  console.log(`\n  ${pid}: leaderEvents=${leaderCount}  intents=${intentCount}  unprocessed=${unprocessed}  online=${online ? 'YES' : 'NO ('+hbAge+'m ago)'}`);

  // Last intent timestamp
  const lastIntent = await p.copyIntent.findFirst({ where: { profileId: pid }, orderBy: { ts: 'desc' }, select: { ts: true, status: true, reason: true } });
  const lastLeader = await p.leaderEvent.findFirst({ where: { profileId: pid }, orderBy: { ts: 'desc' }, select: { ts: true } });
  console.log(`    Last intent:      ${lastIntent?.ts?.toLocaleString('en-GB')} ${lastIntent?.status} ${lastIntent?.reason ?? ''}`);
  console.log(`    Last leaderEvent: ${lastLeader?.ts?.toLocaleString('en-GB')}`);
}

await p.$disconnect();
console.log('\n✔ Done');
