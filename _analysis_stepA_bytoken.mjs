// Try Gamma API lookup by tokenId (clobTokenIds) instead of conditionId
import path from 'path';
import { fileURLToPath } from 'url';
import { PrismaClient } from './packages/db/node_modules/@prisma/client/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbUrl = 'file:' + path.resolve(__dirname, './packages/db/prisma/dev.db').replace(/\\/g, '/');
const db = new PrismaClient({ datasources: { db: { url: dbUrl } } });

async function main() {
  const events = await db.leaderEvent.findMany({
    where: { profileId: 'live' },
    select: { tokenId: true, conditionId: true, rawJson: true },
    distinct: ['tokenId'],
    take: 5
  });

  console.log('Trying Gamma API lookup by tokenId (clobTokenIds)...\n');

  for (const ev of events) {
    const title = (() => { try { return JSON.parse(ev.rawJson).title || ''; } catch { return ''; } })();
    // Try clobTokenIds query param
    const url = `https://gamma-api.polymarket.com/markets?clobTokenIds=${ev.tokenId}`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      const data = await res.json();
      const market = Array.isArray(data) ? data[0] : data;
      if (!market) { console.log(`"${title}" — no result`); continue; }

      console.log(`"${title}"`);
      console.log(`  market.question: ${market.question}`);
      console.log(`  market.slug: ${market.slug}`);
      console.log(`  market.endDateIso: ${market.endDateIso}`);
      console.log(`  market.startDateIso: ${market.startDateIso}`);
      console.log(`  market.closed: ${market.closed}`);
      // Check events[0] for category/tags
      if (market.events && market.events.length > 0) {
        const evt = market.events[0];
        console.log(`  event.title: ${evt.title}`);
        console.log(`  event.slug: ${evt.slug}`);
        // Check eventMetadata for sport
        if (evt.eventMetadata) {
          console.log(`  event.eventMetadata: ${JSON.stringify(evt.eventMetadata)}`);
        }
      }
      console.log();
    } catch (e) {
      console.log(`  error: ${e.message}`);
    }
  }

  await db.$disconnect();
}

main().catch(e => { console.error(e.message); db.$disconnect(); });
