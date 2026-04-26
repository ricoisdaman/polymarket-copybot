// Diagnose why live shows no closed trades
import path from 'path';
import { fileURLToPath } from 'url';
import { PrismaClient } from './packages/db/node_modules/@prisma/client/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbUrl = 'file:' + path.resolve(__dirname, './packages/db/prisma/dev.db').replace(/\\/g, '/');
const db = new PrismaClient({ datasources: { db: { url: dbUrl } } });

async function main() {
  // Check all intent statuses and sides for live
  const intents = await db.copyIntent.groupBy({
    by: ['profileId', 'side', 'status', 'mode'],
    _count: { id: true },
    where: { profileId: { in: ['live', 'paper-v2'] } },
    orderBy: { profileId: 'asc' }
  });
  console.log('=== INTENT SIDE/STATUS BREAKDOWN ===');
  for (const r of intents) console.log(`  ${r.profileId} | ${r.mode} | ${r.side} | ${r.status}: ${r._count.id}`);

  // Check fills by side for live
  const fills = await db.fill.findMany({ where: { profileId: 'live' }, select: { orderId: true, price: true, size: true } });
  const orders = await db.order.findMany({ where: { profileId: 'live' }, select: { id: true, intentId: true } });
  const intentSides = await db.copyIntent.findMany({ where: { profileId: 'live' }, select: { id: true, side: true, tokenId: true } });
  const intentMap = new Map(intentSides.map(i => [i.id, i]));
  const orderMap = new Map(orders.map(o => [o.id, o.intentId]));

  let buyFills = 0, sellFills = 0, unknownFills = 0;
  const sellPrices = [];
  for (const f of fills) {
    const intentId = orderMap.get(f.orderId);
    const intent = intentId ? intentMap.get(intentId) : null;
    if (!intent) { unknownFills++; continue; }
    if (intent.side === 'BUY') buyFills++;
    else if (intent.side === 'SELL') { sellFills++; sellPrices.push(f.price); }
    else unknownFills++;
  }
  console.log(`\n=== LIVE FILLS BY SIDE ===`);
  console.log(`  BUY: ${buyFills} | SELL: ${sellFills} | Unknown: ${unknownFills}`);
  if (sellPrices.length) console.log(`  Sell prices: ${sellPrices.map(p => p.toFixed(4)).join(', ')}`);

  // Check position table for live — closed (size=0) vs open
  const positions = await db.position.findMany({ where: { profileId: 'live' }, select: { tokenId: true, size: true, avgPrice: true, updatedAt: true } });
  const openPos = positions.filter(p => p.size > 0);
  const closedPos = positions.filter(p => p.size <= 0);
  console.log(`\n=== LIVE POSITIONS ===`);
  console.log(`  Open (size>0): ${openPos.length} | Closed/resolved (size=0): ${closedPos.length} | Total DB rows: ${positions.length}`);

  // Sample of closed positions with avg buy price
  const sample = closedPos.slice(0, 10);
  if (sample.length) {
    console.log(`  Sample closed positions (first 10):`);
    for (const p of sample) console.log(`    token:${p.tokenId.slice(0,12)} avgBuyPrice=$${p.avgPrice.toFixed(4)} closedAt:${p.updatedAt.toISOString().slice(0,16)}`);
  }

  // Paper-v2 sell fill prices as distribution
  const fills2 = await db.fill.findMany({ where: { profileId: 'paper-v2' }, select: { orderId: true, price: true, size: true } });
  const orders2 = await db.order.findMany({ where: { profileId: 'paper-v2' }, select: { id: true, intentId: true } });
  const intents2 = await db.copyIntent.findMany({ where: { profileId: 'paper-v2' }, select: { id: true, side: true } });
  const intentMap2 = new Map(intents2.map(i => [i.id, i]));
  const orderMap2 = new Map(orders2.map(o => [o.id, o.intentId]));
  let b2 = 0, s2 = 0;
  const s2prices = [];
  for (const f of fills2) {
    const iid = orderMap2.get(f.orderId);
    const intent = iid ? intentMap2.get(iid) : null;
    if (!intent) continue;
    if (intent.side === 'BUY') b2++;
    else { s2++; s2prices.push(f.price); }
  }
  const highSells = s2prices.filter(p => p >= 0.95).length;
  const midSells = s2prices.filter(p => p >= 0.70 && p < 0.95).length;
  const lowSells = s2prices.filter(p => p < 0.70).length;
  console.log(`\n=== PAPER-V2 FILLS BY SIDE ===`);
  console.log(`  BUY: ${b2} | SELL: ${s2}`);
  console.log(`  Sell price distribution: >=0.95 (wins): ${highSells} | 0.70-0.95: ${midSells} | <0.70 (losses): ${lowSells}`);
}

main().catch(e => console.error(e.message)).finally(() => db.$disconnect());
