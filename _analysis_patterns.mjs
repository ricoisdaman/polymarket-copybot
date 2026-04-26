// Deep analysis of win/loss patterns with slug-based classification
// Focus: what separates winners from losers in the 0.60-0.88 filter range
import path from 'path';
import { fileURLToPath } from 'url';
import { PrismaClient } from './packages/db/node_modules/@prisma/client/index.js';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbUrl = 'file:' + path.resolve(__dirname, './packages/db/prisma/dev.db').replace(/\\/g,'/');
const prisma = new PrismaClient({datasources:{db:{url:dbUrl}}});

function classifySport(slug) {
  if (!slug) return 'unknown';
  const s = slug.toLowerCase();
  if (s.startsWith('mlb-')) return 'MLB';
  if (s.startsWith('nba-')) return 'NBA';
  if (s.startsWith('nhl-')) return 'NHL';
  if (s.startsWith('nfl-')) return 'NFL';
  if (s.startsWith('cbb-')) return 'NCAA';
  if (s.startsWith('atp-') || s.startsWith('wta-') || s.startsWith('tennis-')) return 'Tennis';
  return s.split('-')[0] || 'unknown';
}

function priceBand(price) {
  const p = Number(price);
  if (p < 0.60) return '<0.60';
  if (p < 0.65) return '0.60-0.65';
  if (p < 0.70) return '0.65-0.70';
  if (p < 0.75) return '0.70-0.75';
  if (p < 0.80) return '0.75-0.80';
  if (p < 0.85) return '0.80-0.85';
  if (p < 0.90) return '0.85-0.90';
  return '>=0.90';
}

function leaderBand(sz) {
  const s = Number(sz);
  if (s < 10) return '<$10';
  if (s < 30) return '$10-30';
  if (s < 60) return '$30-60';
  if (s < 100) return '$60-100';
  if (s < 200) return '$100-200';
  return '$200+';
}

// Get all resolved paper-v2 trades via BUY intents (sport known) + SELL fills (outcome known)
const buyIntents = await prisma.$queryRawUnsafe(`
  SELECT 
    ci.id as intentId, ci.tokenId, ci.leaderSize, ci.desiredNotional,
    le.rawJson,
    o.side,
    f.price as buyPrice, f.size as buyShares
  FROM CopyIntent ci
  JOIN LeaderEvent le ON ci.leaderEventId = le.id
  JOIN "Order" o ON o.intentId = ci.id
  JOIN Fill f ON f.orderId = o.id
  WHERE ci.profileId = 'paper-v2' AND ci.side = 'BUY'
`);

// Get all SELL fills for paper-v2, keyed by tokenId
const sellFills = await prisma.$queryRawUnsafe(`
  SELECT ci.tokenId, SUM(f.price * f.size) as sellRevenue, COUNT(*) as sellCount
  FROM CopyIntent ci
  JOIN "Order" o ON o.intentId = ci.id
  JOIN Fill f ON f.orderId = o.id
  WHERE ci.profileId = 'paper-v2' AND ci.side = 'SELL'
  GROUP BY ci.tokenId
`);
const sellMap = new Map(sellFills.map(s => [s.tokenId, {revenue: Number(s.sellRevenue), count: Number(s.sellCount)}]));

await prisma.$disconnect();

// Build per-tokenId trade summary
const trades = new Map();
for (const r of buyIntents) {
  const key = r.tokenId;
  if (!trades.has(key)) {
    const rj = r.rawJson ? JSON.parse(r.rawJson) : {};
    trades.set(key, {
      tokenId: key,
      slug: rj.slug || rj.eventSlug || '',
      title: rj.title || '',
      buyPrice: 0,
      buyShares: 0,
      buyCost: 0,
      leaderSize: Number(r.leaderSize) || 0,
      buyCount: 0,
    });
  }
  const t = trades.get(key);
  t.buyCost += Number(r.buyPrice) * Number(r.buyShares);
  t.buyShares += Number(r.buyShares);
  t.buyCount++;
  t.buyPrice = t.buyCost / t.buyShares; // weighted avg
}

// Merge sell data
const resolved = [];
const unresolved = [];
for (const [tokenId, t] of trades) {
  const sell = sellMap.get(tokenId);
  if (sell) {
    const pnl = sell.revenue - t.buyCost;
    resolved.push({ ...t, sellRevenue: sell.revenue, pnl, won: pnl > 0 });
  } else {
    unresolved.push(t);
  }
}

console.log(`Total resolved trades: ${resolved.length}`);
console.log(`Unresolved (still open): ${unresolved.length}\n`);

const winners = resolved.filter(t => t.won);
const losers = resolved.filter(t => !t.won);

// Helper: group by key function
function groupBy(arr, keyFn, statFn) {
  const map = {};
  for (const t of arr) {
    const k = keyFn(t);
    if (!map[k]) map[k] = { trades: [], wins: 0, losses: 0, pnl: 0 };
    map[k].trades.push(t);
    if (t.won) map[k].wins++; else map[k].losses++;
    map[k].pnl += t.pnl;
  }
  return map;
}

function printTable(title, grouped, sortBy = 'trades') {
  console.log(`\n=== ${title} ===\n`);
  const entries = Object.entries(grouped);
  entries.sort((a, b) => {
    if (sortBy === 'pnl') return b[1].pnl - a[1].pnl;
    if (sortBy === 'wins') return b[1].wins - a[1].wins;
    return b[1].trades.length - a[1].trades.length;
  });
  const total = resolved.length;
  console.log(`${'Key'.padEnd(14)} ${'N'.padStart(5)} ${'Wins'.padStart(5)} ${'Loss'.padStart(5)} ${'Win%'.padStart(6)} ${'P&L'.padStart(9)}`);
  console.log('-'.repeat(50));
  for (const [k, v] of entries) {
    const n = v.trades.length;
    const winPct = n > 0 ? ((v.wins/n)*100).toFixed(0)+'%' : '-';
    console.log(`${k.padEnd(14)} ${String(n).padStart(5)} ${String(v.wins).padStart(5)} ${String(v.losses).padStart(5)} ${winPct.padStart(6)} ${('$'+v.pnl.toFixed(2)).padStart(9)}`);
  }
}

// 1. By sport
printTable('By Sport', groupBy(resolved, t => classifySport(t.slug)), 'trades');

// 2. By price band
printTable('By Entry Price Band', groupBy(resolved, t => priceBand(t.buyPrice)), 'trades');

// 3. By leader size band
printTable('By Leader Bet Size', groupBy(resolved, t => leaderBand(t.leaderSize)), 'trades');

// 4. Price band × sport (cross tab — only interesting cells)
console.log('\n=== Price Band × Sport (win%) ===\n');
const sports = ['MLB', 'NBA', 'NHL', 'Tennis', 'NCAA'];
const bands = ['0.60-0.65','0.65-0.70','0.70-0.75','0.75-0.80','0.80-0.85','0.85-0.90'];
console.log('Band'.padEnd(12) + sports.map(s => s.padStart(8)).join(''));
console.log('-'.repeat(12 + sports.length * 8));
for (const band of bands) {
  let row = band.padEnd(12);
  for (const sport of sports) {
    const subset = resolved.filter(t => priceBand(t.buyPrice) === band && classifySport(t.slug) === sport);
    if (subset.length === 0) { row += '       -'; continue; }
    const pct = ((subset.filter(t => t.won).length / subset.length) * 100).toFixed(0);
    row += `  ${pct}%(${subset.length})`.padStart(8);
  }
  console.log(row);
}

// 5. Leader size × sport cross tab
console.log('\n=== Leader Size × Sport (win%) ===\n');
const lbands = ['<$10','$10-30','$30-60','$60-100','$100-200','$200+'];
console.log('LeaderSz'.padEnd(12) + sports.map(s => s.padStart(8)).join(''));
console.log('-'.repeat(12 + sports.length * 8));
for (const lb of lbands) {
  let row = lb.padEnd(12);
  for (const sport of sports) {
    const subset = resolved.filter(t => leaderBand(t.leaderSize) === lb && classifySport(t.slug) === sport);
    if (subset.length === 0) { row += '       -'; continue; }
    const pct = ((subset.filter(t => t.won).length / subset.length) * 100).toFixed(0);
    row += `  ${pct}%(${subset.length})`.padStart(8);
  }
  console.log(row);
}

// 6. Show worst losing patterns
console.log('\n=== Worst 10 individual losses ===\n');
losers.sort((a,b) => a.pnl - b.pnl);
for (const t of losers.slice(0,10)) {
  console.log(`  ${classifySport(t.slug).padEnd(7)} price=${t.buyPrice.toFixed(3)} lead=$${t.leaderSize.toFixed(0).padStart(4)} pnl=$${t.pnl.toFixed(2).padStart(6)}  ${t.title.slice(0,40)}`);
}

// 7. Show best 10 winners
console.log('\n=== Best 10 individual wins ===\n');
winners.sort((a,b) => b.pnl - a.pnl);
for (const t of winners.slice(0,10)) {
  console.log(`  ${classifySport(t.slug).padEnd(7)} price=${t.buyPrice.toFixed(3)} lead=$${t.leaderSize.toFixed(0).padStart(4)} pnl=+$${t.pnl.toFixed(2).padStart(5)}  ${t.title.slice(0,40)}`);
}
