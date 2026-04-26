// STEP 4: 289 rejections breakdown for live profile
import path from 'path';
import { fileURLToPath } from 'url';
import { PrismaClient } from './packages/db/node_modules/@prisma/client/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbUrl = 'file:' + path.resolve(__dirname, './packages/db/prisma/dev.db').replace(/\\/g, '/');
const db = new PrismaClient({ datasources: { db: { url: dbUrl } } });

async function main() {
  const rejected = await db.copyIntent.findMany({
    where: { profileId: 'live', status: 'REJECTED' },
    select: { id: true, reason: true, tokenId: true, leaderEventId: true, desiredNotional: true, ts: true }
  });

  // Count by reason
  const reasonCounts = {};
  for (const r of rejected) {
    const reason = r.reason || 'NO_REASON';
    reasonCounts[reason] = (reasonCounts[reason] || 0) + 1;
  }

  console.log('===== STEP 4: LIVE REJECTIONS BREAKDOWN =====');
  console.log(`Total rejected intents: ${rejected.length}\n`);
  console.log('  Reason                          | Count |  %');
  console.log('  --------------------------------|-------|----');
  for (const [reason, count] of Object.entries(reasonCounts).sort((a, b) => b[1] - a[1])) {
    const pct = ((count / rejected.length) * 100).toFixed(1);
    console.log(`  ${reason.padEnd(31)} |  ${String(count).padStart(4)} | ${pct}%`);
  }

  // Get market titles for rejections
  const leaderEventIds = rejected.map(r => r.leaderEventId).filter(Boolean);
  const leaderEvents = await db.leaderEvent.findMany({
    where: { id: { in: leaderEventIds } },
    select: { id: true, rawJson: true, tokenId: true }
  });
  const titleById = new Map();
  for (const ev of leaderEvents) {
    try { titleById.set(ev.id, JSON.parse(ev.rawJson).title || ''); } catch { titleById.set(ev.id, ''); }
  }

  // Group by reason — show sample titles and notionals
  for (const [reason, count] of Object.entries(reasonCounts).sort((a, b) => b[1] - a[1])) {
    const samples = rejected.filter(r => (r.reason || 'NO_REASON') === reason).slice(0, 5);
    console.log(`\n── ${reason} (${count} trades) ──`);
    for (const s of samples) {
      const title = titleById.get(s.leaderEventId) || '(no title)';
      console.log(`  $${s.desiredNotional.toFixed(2)} | ${new Date(s.ts).toISOString().slice(0,16)} | "${title.slice(0,60)}"`);
    }
  }

  // Cross-check: how many rejected tokens later got FILLED (i.e. we retried and succeeded)?
  const rejectedTokenIds = new Set(rejected.map(r => r.tokenId));
  const filledTokenIds = new Set(
    (await db.copyIntent.findMany({ where: { profileId: 'live', status: 'FILLED' }, select: { tokenId: true } })).map(i => i.tokenId)
  );
  const overlap = [...rejectedTokenIds].filter(t => filledTokenIds.has(t)).length;
  console.log(`\n── RETRY ANALYSIS ──`);
  console.log(`  Rejected token IDs: ${rejectedTokenIds.size}`);
  console.log(`  Of those, also had a FILLED intent: ${overlap} (${((overlap/rejectedTokenIds.size)*100).toFixed(0)}%)`);
  console.log(`  Pure missed trades (rejected only, never filled): ${rejectedTokenIds.size - overlap}`);

  // Timeline: when are rejections happening?
  const rejByDay = {};
  for (const r of rejected) {
    const day = new Date(r.ts).toISOString().slice(0, 10);
    rejByDay[day] = (rejByDay[day] || 0) + 1;
  }
  console.log('\n── REJECTIONS BY DAY ──');
  for (const [day, count] of Object.entries(rejByDay).sort()) {
    console.log(`  ${day}: ${count}`);
  }
}

main().catch(e => console.error(e.message)).finally(() => db.$disconnect());
