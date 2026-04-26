// Dig into the 'events' field and other nested data from Gamma API
import path from 'path';
import { fileURLToPath } from 'url';
import { PrismaClient } from './packages/db/node_modules/@prisma/client/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbUrl = 'file:' + path.resolve(__dirname, './packages/db/prisma/dev.db').replace(/\\/g, '/');
const db = new PrismaClient({ datasources: { db: { url: dbUrl } } });

async function main() {
  // Get a variety of conditionIds - mix of sports we know are in the data
  const events = await db.leaderEvent.findMany({
    where: { profileId: 'live' },
    select: { conditionId: true, rawJson: true },
    distinct: ['conditionId'],
    take: 50
  });

  console.log('Probing Gamma API events field on 5 samples...\n');

  // Pick 5 with known different titles
  const samples = events.slice(0, 5);
  for (const ev of samples) {
    const title = (() => { try { return JSON.parse(ev.rawJson).title || ''; } catch { return ''; } })();
    const url = `https://gamma-api.polymarket.com/markets?conditionIds=${ev.conditionId}`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      const data = await res.json();
      const market = Array.isArray(data) ? data[0] : data;
      if (!market) continue;

      console.log(`"${title}"`);
      // Dig into events
      if (market.events && Array.isArray(market.events) && market.events.length > 0) {
        const evt = market.events[0];
        console.log(`  events[0] keys: ${Object.keys(evt).join(', ')}`);
        console.log(`  events[0].title: ${evt.title}`);
        console.log(`  events[0].category: ${evt.category}`);
        console.log(`  events[0].sub_category: ${evt.subCategory ?? evt.sub_category}`);
        console.log(`  events[0].tags: ${JSON.stringify(evt.tags)}`);
        console.log(`  events[0].startDate: ${evt.startDate}`);
        console.log(`  events[0].endDate: ${evt.endDate}`);
      } else {
        console.log(`  events: ${JSON.stringify(market.events)}`);
      }
      console.log(`  market.endDateIso: ${market.endDateIso}`);
      console.log(`  market.slug: ${market.slug}`);
      console.log();
    } catch (e) {
      console.log(`  error: ${e.message}`);
    }
  }

  await db.$disconnect();
}

main().catch(e => { console.error(e.message); db.$disconnect(); });
