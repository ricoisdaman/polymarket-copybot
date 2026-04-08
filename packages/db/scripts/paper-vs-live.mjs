/**
 * Correct paper-v2/v3 vs live comparison using dedupeKey cross-referencing
 * (CopyIntent.leaderEventId references profile-local LeaderEvent IDs, not shared)
 */
import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();

const SINCE_DAYS = 7;
const since = new Date(Date.now() - SINCE_DAYS * 24 * 60 * 60 * 1000);

function pct(a, b) { return b === 0 ? 'n/a' : ((a / b) * 100).toFixed(1) + '%'; }
function sep(label) {
  console.log('\n' + '═'.repeat(72));
  console.log('  ' + label);
  console.log('═'.repeat(72));
}

// Get all filled CopyIntents with their LeaderEvent dedupeKey for each profile
// dedupeKey is stable across profiles since it comes from the on-chain event
async function getFilledDedupeKeys(profileId) {
  const intents = await p.copyIntent.findMany({
    where: { profileId, status: 'FILLED', ts: { gte: since } }
  });
  const leaderEvIds = intents.map(i => i.leaderEventId);
  if (!leaderEvIds.length) return new Set();
  const events = await p.leaderEvent.findMany({
    where: { profileId, id: { in: leaderEvIds } },
    select: { id: true, dedupeKey: true }
  });
  const evMap = new Map(events.map(e => [e.id, e.dedupeKey]));
  return new Set(intents.map(i => evMap.get(i.leaderEventId)).filter(Boolean));
}

async function getSkippedWithDedupeKeys(profileId) {
  const intents = await p.copyIntent.findMany({
    where: { profileId, status: 'SKIPPED', ts: { gte: since } }
  });
  const leaderEvIds = intents.map(i => i.leaderEventId);
  if (!leaderEvIds.length) return [];
  const events = await p.leaderEvent.findMany({
    where: { profileId, id: { in: leaderEvIds } },
    select: { id: true, dedupeKey: true, price: true, side: true, usdcSize: true }
  });
  const evMap = new Map(events.map(e => [e.id, e]));
  return intents.map(i => ({
    ...i,
    dedupeKey: evMap.get(i.leaderEventId)?.dedupeKey,
    leaderPrice: evMap.get(i.leaderEventId)?.price,
    leaderUsdcSize: evMap.get(i.leaderEventId)?.usdcSize,
  })).filter(i => i.dedupeKey);
}

// ─── COMPARE PAPER-V2 vs LIVE ─────────────────────────────────────────────────
sep('PAPER-V2 vs LIVE — trades the same leader, same price filter. What did v2 fill that live missed?');

const liveFilledKeys   = await getFilledDedupeKeys('live');
const v2FilledKeys     = await getFilledDedupeKeys('paper-v2');
const v3FilledKeys     = await getFilledDedupeKeys('paper-v3');
const liveSkipped      = await getSkippedWithDedupeKeys('live');

console.log(`  live filled:     ${liveFilledKeys.size}`);
console.log(`  paper-v2 filled: ${v2FilledKeys.size}`);
console.log(`  paper-v3 filled: ${v3FilledKeys.size}`);

const v2OnlyKeys = [...v2FilledKeys].filter(k => !liveFilledKeys.has(k));
const v3OnlyKeys = [...v3FilledKeys].filter(k => !liveFilledKeys.has(k));
const inBothV2Live = [...v2FilledKeys].filter(k => liveFilledKeys.has(k));

console.log(`\n  Overlap (same trades in both v2 and live): ${inBothV2Live.length}`);
console.log(`  paper-v2 filled but live did NOT: ${v2OnlyKeys.length}`);
console.log(`  paper-v3 filled but live did NOT: ${v3OnlyKeys.length}`);

// For v2-only fills, find why live skipped them
const liveSkipMap = new Map(liveSkipped.map(s => [s.dedupeKey, s.reason]));
const v2MissReasons = {};
const v2MissExamples = [];
for (const key of v2OnlyKeys) {
  const reason = liveSkipMap.get(key) ?? 'NOT_SEEN_BY_LIVE';
  v2MissReasons[reason] = (v2MissReasons[reason] ?? 0) + 1;
  if (v2MissExamples.length < 8) {
    const sk = liveSkipped.find(s => s.dedupeKey === key);
    if (sk) v2MissExamples.push({ reason, price: sk.leaderPrice, usdcSize: sk.leaderUsdcSize });
  }
}
console.log('\n  Reasons live missed v2 trades:');
Object.entries(v2MissReasons).sort((a, b) => b[1] - a[1]).forEach(([r, c]) => {
  console.log(`    ${r.padEnd(45)} ${c}`);
});

// ─── V3-ONLY fills — these are trades below 70c or above 80c ─────────────────
sep('PAPER-V3 vs LIVE — v3 has no price filter, what extra trades does it capture?');

const v3OnlyLiveSkipReasons = {};
for (const key of v3OnlyKeys) {
  const reason = liveSkipMap.get(key) ?? 'NOT_SEEN_BY_LIVE';
  v3OnlyLiveSkipReasons[reason] = (v3OnlyLiveSkipReasons[reason] ?? 0) + 1;
}
console.log(`  v3 filled, live did NOT: ${v3OnlyKeys.length}`);
console.log('  Breakdown of why live missed them:');
Object.entries(v3OnlyLiveSkipReasons).sort((a, b) => b[1] - a[1]).forEach(([r, c]) => {
  console.log(`    ${r.padEnd(45)} ${c}`);
});

// Get price distribution of v3-only fills
const v3OnlySet = new Set(v3OnlyKeys);
const v3AllIntents = await p.copyIntent.findMany({
  where: { profileId: 'paper-v3', status: 'FILLED', ts: { gte: since } }
});
const v3LeaderEvIds = v3AllIntents.map(i => i.leaderEventId);
const v3Events = v3LeaderEvIds.length ? await p.leaderEvent.findMany({
  where: { profileId: 'paper-v3', id: { in: v3LeaderEvIds } },
  select: { id: true, dedupeKey: true, price: true, side: true }
}) : [];
const v3EvMap = new Map(v3Events.map(e => [e.dedupeKey, e]));

const pBounds = [0, 0.5, 0.6, 0.7, 0.75, 0.8, 0.9, 1.01];
const pLabels = ['<50c','50-60c','60-70c','70-75c','75-80c','80-90c','>90c'];
const v3OnlyBkt = Array(7).fill(0), v3SharedBkt = Array(7).fill(0);
for (const key of v3FilledKeys) {
  const ev = v3EvMap.get(key);
  if (!ev) continue;
  const i = pBounds.findIndex((b, ix) => ev.price >= b && ev.price < pBounds[ix + 1]);
  if (i < 0) continue;
  if (v3OnlySet.has(key)) v3OnlyBkt[i]++;
  else v3SharedBkt[i]++;
}
console.log('\n  Price distribution of v3 fills:');
console.log('  Bucket       v3-only(live missed)  shared-with-live');
pLabels.forEach((l, i) => {
  console.log(`  ${l.padEnd(12)} ${String(v3OnlyBkt[i]).padStart(18)}  ${String(v3SharedBkt[i]).padStart(16)}`);
});

// ─── PAUSED analysis — when/why was the live bot paused? ─────────────────────
sep('PAUSED skips analysis — what the bot missed while paused (last 7 days)');
const pausedSkips = liveSkipped.filter(s => s.reason === 'PAUSED');
const drawdownSkips = liveSkipped.filter(s => s.reason === 'DRAWDOWN_STOP');
console.log(`  PAUSED skips:        ${pausedSkips.length}`);
console.log(`  DRAWDOWN_STOP skips: ${drawdownSkips.length}`);

// Were any of those >70c buys?
const pausedHighConf = pausedSkips.filter(s => (s.leaderPrice ?? 0) >= 0.70);
const ddHighConf     = drawdownSkips.filter(s => (s.leaderPrice ?? 0) >= 0.70);
console.log(`  PAUSED skips at ≥70c leader price:        ${pausedHighConf.length}`);
console.log(`  DRAWDOWN_STOP skips at ≥70c leader price: ${ddHighConf.length}`);

const totalHighConfMissed = pausedHighConf.length + ddHighConf.length;
if (totalHighConfMissed > 0) {
  const potentialMissedNotional = totalHighConfMissed * 3; // $3/trade
  console.log(`\n  ⚠  Up to ${totalHighConfMissed} high-confidence trades missed while paused/stopped`);
  console.log(`     = up to $${potentialMissedNotional} in lost trading opportunity`);
}

await p.$disconnect();
console.log('\n✓ Done');
