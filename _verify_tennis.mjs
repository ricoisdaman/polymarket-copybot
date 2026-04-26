// Deep verification: is Tennis definitively negative and why?
import path from 'path';
import { fileURLToPath } from 'url';
import { PrismaClient } from './packages/db/node_modules/@prisma/client/index.js';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbUrl = 'file:' + path.resolve(__dirname, './packages/db/prisma/dev.db').replace(/\\/g,'/');
const prisma = new PrismaClient({datasources:{db:{url:dbUrl}}});

const buyData = await prisma.$queryRawUnsafe(`
  SELECT ci.tokenId, ci.leaderSize, f.price as buyPrice, f.size as buyShares, le.rawJson
  FROM CopyIntent ci
  JOIN LeaderEvent le ON ci.leaderEventId = le.id
  JOIN "Order" o ON o.intentId = ci.id
  JOIN Fill f ON f.orderId = o.id
  WHERE ci.profileId = 'paper-v2' AND ci.side = 'BUY'
`);

const sellFills = await prisma.$queryRawUnsafe(`
  SELECT ci.tokenId, SUM(f.price * f.size) as sellRevenue
  FROM CopyIntent ci JOIN "Order" o ON o.intentId = ci.id JOIN Fill f ON f.orderId = o.id
  WHERE ci.profileId = 'paper-v2' AND ci.side = 'SELL'
  GROUP BY ci.tokenId
`);
const sellMap = new Map(sellFills.map(s => [s.tokenId, Number(s.sellRevenue)]));
await prisma.$disconnect();

const trades = new Map();
for (const r of buyData) {
  const rj = r.rawJson ? JSON.parse(r.rawJson) : {};
  const slug = (rj.slug || rj.eventSlug || '').toLowerCase();
  if (!trades.has(r.tokenId)) {
    trades.set(r.tokenId, { tokenId: r.tokenId, slug, title: rj.title||'', buyCost: 0, buyShares: 0, leaderSize: Number(r.leaderSize)||0 });
  }
  const t = trades.get(r.tokenId);
  t.buyCost += Number(r.buyPrice) * Number(r.buyShares);
  t.buyShares += Number(r.buyShares);
}

const resolved = [];
for (const [tid, t] of trades) {
  const rev = sellMap.get(tid);
  if (rev !== undefined) resolved.push({ ...t, pnl: rev - t.buyCost, won: (rev - t.buyCost) > 0, exitPrice: rev / t.buyShares });
}

const tennis = resolved.filter(t => t.slug.startsWith('atp-') || t.slug.startsWith('wta-') || t.slug.startsWith('tennis-'));
const other  = resolved.filter(t => !t.slug.startsWith('atp-') && !t.slug.startsWith('wta-') && !t.slug.startsWith('tennis-'));

function stats(arr) {
  const wins = arr.filter(t => t.won);
  const losses = arr.filter(t => !t.won);
  const totalPnl = arr.reduce((s,t) => s+t.pnl, 0);
  const avgWinPnl = wins.length ? wins.reduce((s,t)=>s+t.pnl,0)/wins.length : 0;
  const avgLossPnl = losses.length ? losses.reduce((s,t)=>s+t.pnl,0)/losses.length : 0;
  const avgBuyPrice = arr.length ? arr.reduce((s,t)=>s+(t.buyCost/t.buyShares),0)/arr.length : 0;
  return { n: arr.length, wins: wins.length, losses: losses.length, totalPnl, avgWinPnl, avgLossPnl, avgBuyPrice };
}

const ts = stats(tennis);
const os = stats(other);

console.log('=== Tennis vs Non-Tennis (paper-v2, resolved only) ===\n');
for (const [label, s] of [['Tennis', ts], ['Non-Tennis', os]]) {
  console.log(`${label}:`);
  console.log(`  Trades: ${s.n}  Wins: ${s.wins} (${((s.wins/s.n)*100).toFixed(0)}%)  Losses: ${s.losses}`);
  console.log(`  Total P&L: $${s.totalPnl.toFixed(2)}`);
  console.log(`  Avg win: +$${s.avgWinPnl.toFixed(2)}   Avg loss: -$${Math.abs(s.avgLossPnl).toFixed(2)}   (ratio: ${(Math.abs(s.avgLossPnl)/s.avgWinPnl).toFixed(2)}x)`);
  console.log(`  Avg entry price: ${s.avgBuyPrice.toFixed(3)}`);
  console.log();
}

// Tennis by price band
console.log('=== Tennis P&L by price band ===\n');
const tBands = ['<0.60','0.60-0.65','0.65-0.70','0.70-0.75','0.75-0.80','0.80-0.85','0.85-0.90'];
function pBand(p) {
  if (p < 0.60) return '<0.60';
  if (p < 0.65) return '0.60-0.65';
  if (p < 0.70) return '0.65-0.70';
  if (p < 0.75) return '0.70-0.75';
  if (p < 0.80) return '0.75-0.80';
  if (p < 0.85) return '0.80-0.85';
  return '0.85-0.90';
}
for (const band of tBands) {
  const subset = tennis.filter(t => pBand(t.buyCost/t.buyShares) === band);
  if (!subset.length) continue;
  const wins = subset.filter(t => t.won).length;
  const pnl = subset.reduce((s,t)=>s+t.pnl,0);
  console.log(`  ${band}: ${subset.length} trades, ${wins} wins (${((wins/subset.length)*100).toFixed(0)}%), P&L=$${pnl.toFixed(2)}`);
}

// ATP vs WTA
console.log('\n=== ATP vs WTA ===\n');
for (const [label, fn] of [['ATP', t => t.slug.startsWith('atp-')], ['WTA', t => t.slug.startsWith('wta-')]]) {
  const s = stats(tennis.filter(fn));
  if (!s.n) continue;
  console.log(`  ${label}: ${s.n} trades  ${s.wins}W/${s.losses}L (${((s.wins/s.n)*100).toFixed(0)}%)  P&L=$${s.totalPnl.toFixed(2)}  avgWin=+$${s.avgWinPnl.toFixed(2)}  avgLoss=-$${Math.abs(s.avgLossPnl).toFixed(2)}`);
}

// Worst tennis losses
console.log('\n=== Tennis losses (worst first) ===\n');
tennis.filter(t => !t.won).sort((a,b) => a.pnl-b.pnl).forEach(t => {
  const price = (t.buyCost/t.buyShares).toFixed(3);
  console.log(`  $${t.pnl.toFixed(2)} | ${price} entry | lead=$${t.leaderSize.toFixed(0)} | ${t.title.slice(0,50)}`);
});
