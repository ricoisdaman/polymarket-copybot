// Probe rawJson slug + eventSlug fields and try Gamma API by slug
import path from 'path';
import { fileURLToPath } from 'url';
import { PrismaClient } from './packages/db/node_modules/@prisma/client/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbUrl = 'file:' + path.resolve(__dirname, './packages/db/prisma/dev.db').replace(/\\/g, '/');
const prisma = new PrismaClient({ datasources: { db: { url: dbUrl } } });

const rows = await prisma.leaderEvent.findMany({
  where: {
    profileId: 'live',
  },
  orderBy: { ts: 'desc' },
  take: 50,
  select: { tokenId: true, conditionId: true, rawJson: true },
});

console.log(`=== rawJson slug/eventSlug/outcome/outcomeIndex sample ===\n`);

const slugSet = new Set();
let shown = 0;
for (const row of rows) {
  if (!row.rawJson) continue;
  const rj = JSON.parse(row.rawJson);
  if (!rj.title?.includes(' vs')) continue;
  if (shown >= 10) { if (rj.slug) slugSet.add(rj.slug); continue; }
  shown++;
  const slug = rj.slug;
  const eventSlug = rj.eventSlug;
  const outcome = rj.outcome;
  const outcomeIndex = rj.outcomeIndex;
  const title = rj.title;
  console.log(`title: ${title}`);
  console.log(`  slug: ${slug}`);
  console.log(`  eventSlug: ${eventSlug}`);
  console.log(`  outcome: ${outcome}  outcomeIndex: ${outcomeIndex}`);
  console.log();
  if (slug) slugSet.add(slug);
}

await prisma.$disconnect();

// Try Gamma API by slug for first 3 unique slugs
const slugs = [...slugSet].slice(0, 3);
console.log(`\n=== Gamma API lookup by slug ===\n`);

for (const slug of slugs) {
  const url = `https://gamma-api.polymarket.com/markets?slug=${encodeURIComponent(slug)}&limit=1`;
  console.log(`GET ${url}`);
  try {
    const res = await fetch(url);
    const data = await res.json();
    if (!Array.isArray(data) || data.length === 0) {
      console.log(`  -> empty or non-array response`);
      continue;
    }
    const m = data[0];
    const ev = m.events?.[0] ?? {};
    console.log(`  market.question: ${m.question}`);
    console.log(`  market.slug: ${m.slug}`);
    console.log(`  market.endDateIso: ${m.endDateIso}`);
    console.log(`  market.category: ${m.category ?? 'n/a'}`);
    console.log(`  market.tags: ${JSON.stringify(m.tags ?? 'n/a')}`);
    console.log(`  event.title: ${ev.title}`);
    console.log(`  event.slug: ${ev.slug}`);
    console.log(`  groupItemTitle: ${m.groupItemTitle ?? 'n/a'}`);
    console.log(`  ALL market keys: ${Object.keys(m).join(', ')}`);
  } catch (e) {
    console.log(`  ERROR: ${e.message}`);
  }
  console.log();
}
