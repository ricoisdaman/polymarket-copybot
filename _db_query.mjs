import path from 'path';
import { fileURLToPath } from 'url';
import { PrismaClient } from './packages/db/node_modules/@prisma/client/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbUrl = 'file:' + path.resolve(__dirname, './packages/db/prisma/dev.db').replace(/\\/g, '/');
const db = new PrismaClient({ datasources: { db: { url: dbUrl } } });

async function main() {
  // Profiles
  const profileRows = await db.runtimeMetric.findMany({ select: { profileId: true }, distinct: ['profileId'] });
  console.log('\n=== PROFILES ===');
  console.log(profileRows.map(r => r.profileId).join(', '));

  // Intent counts by profile + mode + status
  const intentGroups = await db.copyIntent.groupBy({ by: ['profileId', 'mode', 'status'], _count: { id: true }, orderBy: { profileId: 'asc' } });
  console.log('\n=== INTENT COUNTS (profileId / mode / status) ===');
  for (const g of intentGroups) console.log(`  ${g.profileId} | ${g.mode} | ${g.status}: ${g._count.id}`);

  // Fill counts + total value per profile
  const fills = await db.fill.findMany({ select: { profileId: true, price: true, size: true } });
  const fillsByProfile = {};
  for (const f of fills) {
    if (!fillsByProfile[f.profileId]) fillsByProfile[f.profileId] = { count: 0, notional: 0 };
    fillsByProfile[f.profileId].count++;
    fillsByProfile[f.profileId].notional += f.price * f.size;
  }
  console.log('\n=== FILLS PER PROFILE ===');
  for (const [p, v] of Object.entries(fillsByProfile)) console.log(`  ${p}: ${v.count} fills, $${v.notional.toFixed(2)} total notional`);

  // Leader events per profile
  const leGroups = await db.leaderEvent.groupBy({ by: ['profileId'], _count: { id: true } });
  console.log('\n=== LEADER EVENTS PER PROFILE ===');
  for (const g of leGroups) console.log(`  ${g.profileId}: ${g._count.id} events`);

  // Open positions per profile
  const openPos = await db.position.findMany({ where: { size: { gt: 0 } }, orderBy: { profileId: 'asc' } });
  console.log(`\n=== OPEN POSITIONS: ${openPos.length} total ===`);
  for (const p of openPos) console.log(`  ${p.profileId} | token:${p.tokenId.slice(0,12)}... | ${p.size.toFixed(2)} shares @ $${p.avgPrice.toFixed(4)}`);

  // Runtime metrics for cash/drawdown
  const metrics = await db.runtimeMetric.findMany({ where: { key: { in: ['bot.cash_usdc','bot.drawdown_usdc','bot.live_starting_usdc','bot.mode'] } }, orderBy: { profileId: 'asc' } });
  console.log('\n=== KEY RUNTIME METRICS ===');
  for (const m of metrics) console.log(`  ${m.profileId} | ${m.key}: ${m.value}`);
}

main().catch(e => { console.error(e.message); process.exit(1); }).finally(() => db.$disconnect());
