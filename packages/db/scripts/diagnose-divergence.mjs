import { PrismaClient } from '@prisma/client';
const p = new PrismaClient({ datasources: { db: { url: 'file:C:/Users/Rico/new-bot-GPT/packages/db/prisma/dev.db' } } });

async function main() {
  // Count orphaned leader events for paper-v2 (events with no matching copy intent)
  const cutoff = new Date(Date.now() - 8000);
  const events = await p.leaderEvent.findMany({
    where: { profileId: 'paper-v2', ts: { lt: cutoff } },
    select: { id: true, ts: true }
  });
  const eventIds = events.map(e => e.id);

  const linked = await p.copyIntent.findMany({
    where: { profileId: 'paper-v2', leaderEventId: { in: eventIds } },
    select: { leaderEventId: true }
  });
  const linkedSet = new Set(linked.map(i => i.leaderEventId));
  const orphaned = events.filter(e => !linkedSet.has(e.id));

  console.log(`total leaderEvents: ${events.length}  linked: ${linked.length}  orphaned: ${orphaned.length}`);

  if (orphaned.length > 0) {
    const oldest = orphaned.reduce((a, b) => (a.ts < b.ts ? a : b));
    const newest = orphaned.reduce((a, b) => (a.ts > b.ts ? a : b));
    console.log(`oldest orphan: ${oldest.ts.toISOString()}`);
    console.log(`newest orphan: ${newest.ts.toISOString()}`);

    // Bucket by date
    const byDay = {};
    orphaned.forEach(e => {
      const d = e.ts.toISOString().slice(0, 10);
      byDay[d] = (byDay[d] || 0) + 1;
    });
    console.log('\nOrphans by day:');
    for (const [day, count] of Object.entries(byDay).sort()) {
      console.log(`  ${day}: ${count}`);
    }
  }

  // Check all profiles for orphan counts
  console.log('\n--- Orphan count per profile ---');
  for (const pid of ['live', 'paper-v2', 'paper-v3', 'paper-sports-b']) {
    const evts = await p.leaderEvent.findMany({ where: { profileId: pid }, select: { id: true } });
    if (evts.length === 0) { console.log(`  ${pid}: 0 events`); continue; }
    const lnk = await p.copyIntent.findMany({
      where: { profileId: pid, leaderEventId: { in: evts.map(e => e.id) } },
      select: { leaderEventId: true }
    });
    const lSet = new Set(lnk.map(i => i.leaderEventId));
    const orp = evts.filter(e => !lSet.has(e.id)).length;
    console.log(`  ${pid}: events=${evts.length}  linked=${lnk.length}  orphaned=${orp} (${(orp/evts.length*100).toFixed(1)}%)`);
  }

  // Check live_starting_usdc metric
  const m = await p.runtimeMetric.findFirst({ where: { profileId: 'live', key: 'bot.live_starting_usdc' } });
  console.log(`\nbot.live_starting_usdc (live): ${m?.value}`);

  // Show current drawdown baselines
  for (const pid of ['live', 'paper-v2', 'paper-v3']) {
    const cash = await p.runtimeMetric.findFirst({ where: { profileId: pid, key: 'bot.cash_usdc' } });
    const dd = await p.runtimeMetric.findFirst({ where: { profileId: pid, key: 'bot.drawdown_usdc' } });
    console.log(`  ${pid}: cash=${cash?.value}  drawdown=${dd?.value}`);
  }

  await p.$disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
