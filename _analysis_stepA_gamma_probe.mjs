// Quick probe: fetch Gamma API for a sample of conditionIds from our DB
// to confirm what metadata fields are available before building the enrichment
import path from 'path';
import { fileURLToPath } from 'url';
import { PrismaClient } from './packages/db/node_modules/@prisma/client/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbUrl = 'file:' + path.resolve(__dirname, './packages/db/prisma/dev.db').replace(/\\/g, '/');
const db = new PrismaClient({ datasources: { db: { url: dbUrl } } });

async function main() {
  // Get 5 distinct conditionIds from live filled trades
  const events = await db.leaderEvent.findMany({
    where: { profileId: 'live' },
    select: { conditionId: true, rawJson: true },
    distinct: ['conditionId'],
    take: 5
  });

  console.log('Testing Gamma API for sample conditionIds...\n');

  for (const ev of events) {
    const url = `https://gamma-api.polymarket.com/markets?conditionIds=${ev.conditionId}`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) { console.log(`  ${ev.conditionId}: HTTP ${res.status}`); continue; }
      const data = await res.json();
      const market = Array.isArray(data) ? data[0] : data;
      if (!market) { console.log(`  ${ev.conditionId}: no data`); continue; }

      const titleFromRaw = (() => { try { return JSON.parse(ev.rawJson).title || ''; } catch { return ''; } })();
      console.log(`Title: "${titleFromRaw}"`);
      console.log(`  conditionId:  ${ev.conditionId}`);
      console.log(`  category:     ${market.category ?? 'n/a'}`);
      console.log(`  tags:         ${JSON.stringify(market.tags ?? 'n/a')}`);
      console.log(`  end_date_iso: ${market.endDateIso ?? market.end_date_iso ?? 'n/a'}`);
      console.log(`  closed:       ${market.closed ?? 'n/a'}`);
      console.log(`  volume:       ${market.volume ?? 'n/a'}`);
      console.log(`  liquidity:    ${market.liquidity ?? 'n/a'}`);
      console.log(`  All keys:     ${Object.keys(market).join(', ')}`);
      console.log();
    } catch (e) {
      console.log(`  ${ev.conditionId}: error — ${e.message}`);
    }
  }

  await db.$disconnect();
}

main().catch(e => { console.error(e.message); db.$disconnect(); });
