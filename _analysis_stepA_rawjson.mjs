// Step A: Inspect what fields are in LeaderEvent.rawJson
// Check for category, tags, sport, league, end_date etc.
import path from 'path';
import { fileURLToPath } from 'url';
import { PrismaClient } from './packages/db/node_modules/@prisma/client/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbUrl = 'file:' + path.resolve(__dirname, './packages/db/prisma/dev.db').replace(/\\/g, '/');
const db = new PrismaClient({ datasources: { db: { url: dbUrl } } });

async function main() {
  // Sample 20 recent leader events from live profile
  const events = await db.leaderEvent.findMany({
    where: { profileId: 'live' },
    select: { rawJson: true, tokenId: true },
    orderBy: { ts: 'desc' },
    take: 20
  });

  console.log('=== RAW JSON TOP-LEVEL KEYS (from 20 live events) ===');
  const keySets = [];
  for (const ev of events) {
    try {
      const parsed = JSON.parse(ev.rawJson);
      keySets.push(Object.keys(parsed));
    } catch { keySets.push([]); }
  }
  // Union of all keys
  const allKeys = [...new Set(keySets.flat())].sort();
  console.log('All top-level keys found:', allKeys.join(', '));

  // Print a few examples showing sport/category/tag related fields
  console.log('\n=== SAMPLE EVENTS — sport/category/tag/end_date fields ===');
  for (const ev of events.slice(0, 8)) {
    try {
      const p = JSON.parse(ev.rawJson);
      // Print only fields relevant to sport/category/timing
      const relevant = {
        title: p.title,
        category: p.category,
        tags: p.tags,
        sport: p.sport,
        league: p.league,
        event_slug: p.event_slug,
        market_slug: p.market_slug,
        end_date_iso: p.end_date_iso,
        end_date: p.end_date,
        closes_at: p.closes_at,
        game_start_time: p.game_start_time,
        type: p.type,
        sub_title: p.sub_title,
      };
      // Remove undefined
      const clean = Object.fromEntries(Object.entries(relevant).filter(([, v]) => v !== undefined));
      console.log('\n', JSON.stringify(clean, null, 2));
    } catch { console.log('parse error'); }
  }

  // Count how many events have category/tags fields
  const allLive = await db.leaderEvent.findMany({
    where: { profileId: 'live' },
    select: { rawJson: true },
    take: 1000
  });
  let withCategory = 0, withTags = 0, withEndDate = 0, withSport = 0;
  for (const ev of allLive) {
    try {
      const p = JSON.parse(ev.rawJson);
      if (p.category) withCategory++;
      if (p.tags) withTags++;
      if (p.end_date_iso || p.end_date || p.closes_at) withEndDate++;
      if (p.sport || p.league) withSport++;
    } catch { /* */ }
  }
  console.log(`\n=== FIELD COVERAGE (first 1000 live events) ===`);
  console.log(`  category:    ${withCategory}`);
  console.log(`  tags:        ${withTags}`);
  console.log(`  end_date:    ${withEndDate}`);
  console.log(`  sport/league: ${withSport}`);
  console.log(`  total sampled: ${allLive.length}`);
}

main().catch(e => console.error(e.message)).finally(() => db.$disconnect());
