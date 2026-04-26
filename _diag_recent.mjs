import { PrismaClient } from './packages/db/node_modules/@prisma/client/index.js';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbUrl = 'file:' + path.resolve(__dirname, './packages/db/prisma/dev.db').replace(/\\/g, '/');
const db = new PrismaClient({ datasources: { db: { url: dbUrl } } });

// ── Live bot: all fills by day with slug/title ────────────────────────────────
const rows = await db.$queryRawUnsafe(`
  SELECT 
    DATE(f.ts/1000, 'unixepoch') as day,
    ci.side,
    le.rawJson,
    f.price,
    f.size,
    f.ts
  FROM Fill f
  JOIN "Order" o ON f.orderId = o.id
  JOIN CopyIntent ci ON o.intentId = ci.id
  LEFT JOIN LeaderEvent le ON ci.leaderEventId = le.id
  WHERE ci.profileId = 'live'
  ORDER BY f.ts ASC
`);

const byDay = {};
for (const r of rows) {
  let rj = {};
  try { rj = r.rawJson ? JSON.parse(r.rawJson) : {}; } catch {}
  const slug = (rj.slug || rj.eventSlug || rj.market_slug || '').toLowerCase();
  const title = rj.title || rj.question || '';
  const notional = Number(r.price) * Number(r.size);
  if (!byDay[r.day]) byDay[r.day] = { buys: 0, buyNotional: 0, sells: 0, sellNotional: 0, trades: [] };
  if (r.side === 'BUY') { byDay[r.day].buys++; byDay[r.day].buyNotional += notional; }
  else { byDay[r.day].sells++; byDay[r.day].sellNotional += notional; }
  byDay[r.day].trades.push({ side: r.side, price: Number(r.price), size: Number(r.size), slug, title, ts: new Date(Number(r.ts)).toISOString().slice(0,16) });
}

console.log('=== LIVE BOT: ALL FILLS BY DAY ===\n');
for (const [day, d] of Object.entries(byDay).sort()) {
  console.log(`\n── ${day} ── Buys: ${d.buys} ($${d.buyNotional.toFixed(2)}) | Sells: ${d.sells} ($${d.sellNotional.toFixed(2)})`);
  for (const t of d.trades) {
    console.log(`  ${t.ts} ${t.side.padEnd(4)} $${(t.price * t.size).toFixed(2)} @ ${t.price.toFixed(3)} | ${(t.slug || t.title).slice(0,60)}`);
  }
}

// ── Per-token P&L for live bot (vs open position cost) ───────────────────────
console.log('\n\n=== LIVE BOT: ALL TOKENS (buy cost + settlement/open status) ===\n');
const tokenFills = await db.$queryRawUnsafe(`
  SELECT 
    ci.tokenId, ci.side, 
    SUM(f.price * f.size) as totalCost,
    SUM(f.size) as totalShares,
    MIN(f.ts) as firstTs,
    MAX(f.ts) as lastTs,
    le.rawJson
  FROM Fill f
  JOIN "Order" o ON f.orderId = o.id
  JOIN CopyIntent ci ON o.intentId = ci.id
  LEFT JOIN LeaderEvent le ON ci.leaderEventId = le.id
  WHERE ci.profileId = 'live'
  GROUP BY ci.tokenId, ci.side
  ORDER BY firstTs ASC
`);

const byToken = {};
for (const r of tokenFills) {
  let rj = {};
  try { rj = r.rawJson ? JSON.parse(r.rawJson) : {}; } catch {}
  const slug = (rj.slug || '').toLowerCase();
  const title = rj.title || rj.question || '';
  if (!byToken[r.tokenId]) byToken[r.tokenId] = { slug, title, buyCost: 0, buyShares: 0, sellRev: 0, sellShares: 0 };
  if (r.side === 'BUY') {
    byToken[r.tokenId].buyCost += Number(r.totalCost);
    byToken[r.tokenId].buyShares += Number(r.totalShares);
  } else {
    byToken[r.tokenId].sellRev += Number(r.totalCost);
    byToken[r.tokenId].sellShares += Number(r.totalShares);
  }
}

// Get open positions  
const openPos = await db.position.findMany({ where: { profileId: 'live', size: { gt: 0 } } });
const openSet = new Set(openPos.map(p => p.tokenId));

let totalBuyCost = 0, totalSellRev = 0, settledWins = 0, settledLosses = 0;
let totalSettledPnl = 0;
for (const [tid, t] of Object.entries(byToken)) {
  const hasSell = t.sellShares > 0;
  const isOpen = openSet.has(tid);
  const avgBuy = t.buyCost / t.buyShares;
  let pnlStr = 'OPEN';
  if (hasSell) {
    const pnl = t.sellRev - t.buyCost;
    totalSettledPnl += pnl;
    if (pnl > 0) settledWins++; else settledLosses++;
    pnlStr = `PnL=$${pnl.toFixed(2)} (${pnl > 0 ? 'WIN' : 'LOSS'})`;
  } else if (!isOpen) {
    pnlStr = 'NO-SELL/CLOSED (likely resolved)';
  }
  totalBuyCost += t.buyCost;
  if (hasSell) totalSellRev += t.sellRev;
  const sport = t.slug.startsWith('atp-') ? 'ATP' : t.slug.startsWith('wta-') ? 'WTA' : t.slug.startsWith('tennis-') ? 'TENNIS' : t.slug.startsWith('mlb-') ? 'MLB' : t.slug.startsWith('nba-') ? 'NBA' : t.slug.startsWith('nhl-') ? 'NHL' : 'OTHER';
  console.log(`  [${sport}] $${t.buyCost.toFixed(2)} @ ${avgBuy.toFixed(3)} | ${pnlStr} | ${(t.slug || t.title).slice(0,55)}`);
}
console.log(`\nTotal buy cost: $${totalBuyCost.toFixed(2)}`);
console.log(`Total sell revenue: $${totalSellRev.toFixed(2)}`);
console.log(`Settled trades with sell fills: W=${settledWins} L=${settledLosses} PnL=$${totalSettledPnl.toFixed(2)}`);
console.log(`Starting USDC: $60 | Current cash: $39.01 → Total P&L: ~$${(39.01 - 60).toFixed(2)}`);

await db.$disconnect();
