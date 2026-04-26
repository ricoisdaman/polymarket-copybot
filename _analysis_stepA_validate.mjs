// Validate slug-based sport classification across all LeaderEvents
// Also check sportsMarketType and gameStartTime from Gamma API
import path from 'path';
import { fileURLToPath } from 'url';
import { PrismaClient } from './packages/db/node_modules/@prisma/client/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbUrl = 'file:' + path.resolve(__dirname, './packages/db/prisma/dev.db').replace(/\\/g, '/');
const prisma = new PrismaClient({ datasources: { db: { url: dbUrl } } });

function classifySport(slug) {
  if (!slug) return 'unknown';
  const s = slug.toLowerCase();
  if (s.startsWith('mlb-')) return 'MLB';
  if (s.startsWith('nba-')) return 'NBA';
  if (s.startsWith('nfl-')) return 'NFL';
  if (s.startsWith('nhl-')) return 'NHL';
  if (s.startsWith('ncaab-')) return 'NCAAB';
  if (s.startsWith('ncaaf-')) return 'NCAAF';
  if (s.startsWith('soccer-') || s.startsWith('epl-') || s.startsWith('mls-') || s.startsWith('laliga-') || s.startsWith('ucl-')) return 'Soccer';
  if (s.startsWith('tennis-') || s.startsWith('atp-') || s.startsWith('wta-')) return 'Tennis';
  if (s.startsWith('boxing-') || s.startsWith('mma-') || s.startsWith('ufc-')) return 'Combat';
  if (s.startsWith('politics-') || s.startsWith('us-')) return 'Politics';
  if (s.startsWith('crypto-')) return 'Crypto';
  // Try generic first segment
  const firstSeg = s.split('-')[0];
  return firstSeg || 'unknown';
}

// Get ALL live and paper-v2 LeaderEvents
const rows = await prisma.leaderEvent.findMany({
  where: { profileId: { in: ['live', 'paper-v2'] } },
  select: { profileId: true, tokenId: true, rawJson: true },
  orderBy: { ts: 'desc' },
});

await prisma.$disconnect();

console.log(`Total rows: ${rows.length}\n`);

// Sport distribution
const sportDist = {};
const slugPrefixes = {};
let noSlug = 0;

for (const row of rows) {
  if (!row.rawJson) { noSlug++; continue; }
  const rj = JSON.parse(row.rawJson);
  const slug = rj.slug || rj.eventSlug;
  if (!slug) { noSlug++; continue; }
  
  const sport = classifySport(slug);
  const prefix = slug.split('-')[0];
  
  sportDist[sport] = (sportDist[sport] || 0) + 1;
  slugPrefixes[prefix] = (slugPrefixes[prefix] || 0) + 1;
}

console.log('=== Sport distribution (all profiles combined) ===');
Object.entries(sportDist)
  .sort((a, b) => b[1] - a[1])
  .forEach(([k, v]) => console.log(`  ${k}: ${v} (${((v/rows.length)*100).toFixed(1)}%)`));

console.log('\n=== Slug prefix distribution (raw) ===');
Object.entries(slugPrefixes)
  .sort((a, b) => b[1] - a[1])
  .slice(0, 20)
  .forEach(([k, v]) => console.log(`  ${k}: ${v}`));

console.log(`\nNo slug: ${noSlug}`);

// Per-profile sport breakdown
console.log('\n=== Per-profile sport breakdown ===');
for (const profile of ['live', 'paper-v2']) {
  const profileRows = rows.filter(r => r.profileId === profile);
  const dist = {};
  for (const row of profileRows) {
    if (!row.rawJson) continue;
    const rj = JSON.parse(row.rawJson);
    const slug = rj.slug || rj.eventSlug;
    const sport = classifySport(slug);
    dist[sport] = (dist[sport] || 0) + 1;
  }
  console.log(`\n${profile} (${profileRows.length} total):`);
  Object.entries(dist)
    .sort((a, b) => b[1] - a[1])
    .forEach(([k, v]) => console.log(`  ${k}: ${v} (${((v/profileRows.length)*100).toFixed(1)}%)`));
}

// Now probe Gamma API for sportsMarketType + gameStartTime on 3 slugs
const uniqueSlugs = [...new Set(
  rows.slice(0, 200).map(r => {
    if (!r.rawJson) return null;
    const rj = JSON.parse(r.rawJson);
    return rj.slug;
  }).filter(Boolean)
)].slice(0, 3);

console.log('\n=== Gamma API sportsMarketType + gameStartTime probe ===');
for (const slug of uniqueSlugs) {
  const url = `https://gamma-api.polymarket.com/markets?slug=${encodeURIComponent(slug)}&limit=1`;
  try {
    const res = await fetch(url);
    const data = await res.json();
    if (!Array.isArray(data) || !data.length) { console.log(`${slug} -> empty`); continue; }
    const m = data[0];
    console.log(`\nslug: ${slug}`);
    console.log(`  sportsMarketType: ${m.sportsMarketType ?? 'n/a'}`);
    console.log(`  gameStartTime: ${m.gameStartTime ?? 'n/a'}`);
    console.log(`  endDateIso: ${m.endDateIso ?? 'n/a'}`);
    console.log(`  startDateIso: ${m.startDateIso ?? 'n/a'}`);
    console.log(`  negRisk: ${m.negRisk ?? 'n/a'}`);
    console.log(`  closed: ${m.closed}`);
  } catch (e) {
    console.log(`${slug} -> ERROR: ${e.message}`);
  }
}
