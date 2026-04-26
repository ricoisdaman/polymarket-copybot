import path from 'path';
import { fileURLToPath } from 'url';
import { PrismaClient } from './packages/db/node_modules/@prisma/client/index.js';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbUrl = 'file:' + path.resolve(__dirname, './packages/db/prisma/dev.db').replace(/\\/g,'/');
const prisma = new PrismaClient({datasources:{db:{url:dbUrl}}});

// Recent fills for live profile with full context
const fills = await prisma.$queryRawUnsafe(`
  SELECT 
    f.ts, f.price, f.size, ROUND(f.price * f.size, 4) as usdcValue,
    o.side, o.status as orderStatus,
    ci.tokenId, ci.status as intentStatus, ci.reason,
    ci.desiredNotional, ci.leaderSize,
    le.rawJson
  FROM Fill f
  JOIN "Order" o ON f.orderId = o.id
  JOIN CopyIntent ci ON o.intentId = ci.id
  JOIN LeaderEvent le ON ci.leaderEventId = le.id
  WHERE f.profileId = 'live'
  ORDER BY f.ts DESC
  LIMIT 40
`);

function classifySport(slug) {
  if (!slug) return '?';
  const s = slug.toLowerCase();
  if (s.startsWith('mlb-')) return 'MLB';
  if (s.startsWith('nba-')) return 'NBA';
  if (s.startsWith('nhl-')) return 'NHL';
  if (s.startsWith('nfl-')) return 'NFL';
  if (s.startsWith('cbb-')) return 'NCAA';
  if (s.startsWith('atp-') || s.startsWith('wta-') || s.startsWith('tennis-')) return 'Tennis';
  return s.split('-')[0];
}

console.log('Recent LIVE fills (last 40):');
console.log(`${'Date'.padEnd(12)} ${'Side'.padEnd(5)} ${'Price'.padStart(7)} ${'Shares'.padStart(9)} ${'USDC$'.padStart(7)} ${'LeadSz'.padStart(7)} ${'Sport'.padEnd(7)} Title`);
console.log('-'.repeat(95));

for (const f of fills) {
  const rj = f.rawJson ? JSON.parse(f.rawJson) : {};
  const slug = rj.slug || rj.eventSlug || '';
  const sport = classifySport(slug);
  const title = (rj.title || '').slice(0, 30);
  const date = new Date(f.ts).toISOString().slice(5, 16);
  const leaderSz = f.leaderSize ? `$${Number(f.leaderSize).toFixed(0)}` : '-';
  console.log(
    `${date.padEnd(12)} ${f.side.padEnd(5)} ${Number(f.price).toFixed(3).padStart(7)} ${Number(f.size).toFixed(1).padStart(9)} ${('$'+Number(f.usdcValue).toFixed(2)).padStart(7)} ${leaderSz.padStart(7)} ${sport.padEnd(7)} ${title}`
  );
}

// Also show any fills where usdcValue > 3.10 on BUY side
const bigBuys = fills.filter(f => f.side === 'BUY' && Number(f.usdcValue) > 3.1);
if (bigBuys.length > 0) {
  console.log('\n=== BUY fills > $3.10 ===');
  for (const f of bigBuys) {
    const rj = f.rawJson ? JSON.parse(f.rawJson) : {};
    console.log(`  $${Number(f.usdcValue).toFixed(4)} at ${f.price} x ${f.size} shares | leaderSize=$${f.leaderSize} | desiredNotional=$${f.desiredNotional} | ${rj.title || '?'}`);
  }
} else {
  console.log('\nNo BUY fills above $3.10 found in the last 40.');
}

// Show fill stats by side
const sideStats = {};
for (const f of fills) {
  const k = f.side;
  if (!sideStats[k]) sideStats[k] = { count: 0, totalUsdc: 0 };
  sideStats[k].count++;
  sideStats[k].totalUsdc += Number(f.usdcValue);
}
console.log('\nSummary:');
for (const [side, s] of Object.entries(sideStats)) {
  console.log(`  ${side}: ${s.count} fills, total $${s.totalUsdc.toFixed(2)}`);
}

await prisma.$disconnect();
