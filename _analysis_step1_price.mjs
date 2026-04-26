// STEP 1: Entry price performance by price band
// For each filled+settled trade on live and paper-v2, compute win/loss and group by price band.
// Win = position fully closed at a price higher than avg buy price (realized PnL > 0).
// We derive this from fills: BUY fills establish cost, SELL fills close at exit price.

import path from 'path';
import { fileURLToPath } from 'url';
import { PrismaClient } from './packages/db/node_modules/@prisma/client/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbUrl = 'file:' + path.resolve(__dirname, './packages/db/prisma/dev.db').replace(/\\/g, '/');
const db = new PrismaClient({ datasources: { db: { url: dbUrl } } });

async function analyseProfile(profileId) {
  // Get all fills with their intent side via order→intent join
  const fills = await db.fill.findMany({
    where: { profileId },
    select: { orderId: true, price: true, size: true, ts: true }
  });
  const orders = await db.order.findMany({
    where: { profileId },
    select: { id: true, intentId: true }
  });
  const intents = await db.copyIntent.findMany({
    where: { profileId, status: { in: ['FILLED', 'SETTLED'] } },
    select: { id: true, tokenId: true, side: true }
  });

  const orderToIntent = new Map(orders.map(o => [o.id, o.intentId]));
  const intentById = new Map(intents.map(i => [i.id, i]));

  // Group fills by tokenId with side
  const byToken = {};
  for (const fill of fills) {
    const intentId = orderToIntent.get(fill.orderId);
    if (!intentId) continue;
    const intent = intentById.get(intentId);
    if (!intent) continue;
    const t = intent.tokenId;
    if (!byToken[t]) byToken[t] = { buys: [], sells: [] };
    if (intent.side === 'BUY') byToken[t].buys.push(fill);
    else byToken[t].sells.push(fill);
  }

  // For each token compute: avg buy price, avg sell price, pnl
  const bands = {
    '0.60-0.65': { wins: 0, losses: 0, pnl: 0 },
    '0.65-0.70': { wins: 0, losses: 0, pnl: 0 },
    '0.70-0.75': { wins: 0, losses: 0, pnl: 0 },
    '0.75-0.80': { wins: 0, losses: 0, pnl: 0 },
    '0.80-0.85': { wins: 0, losses: 0, pnl: 0 },
    '0.85-0.90': { wins: 0, losses: 0, pnl: 0 },
    '0.90-0.95': { wins: 0, losses: 0, pnl: 0 },
    '0.95-1.00': { wins: 0, losses: 0, pnl: 0 },
  };

  function getBand(price) {
    if (price < 0.65) return '0.60-0.65';
    if (price < 0.70) return '0.65-0.70';
    if (price < 0.75) return '0.70-0.75';
    if (price < 0.80) return '0.75-0.80';
    if (price < 0.85) return '0.80-0.85';
    if (price < 0.90) return '0.85-0.90';
    if (price < 0.95) return '0.90-0.95';
    return '0.95-1.00';
  }

  let closedTrades = 0;
  let openTrades = 0;
  const tradeDetails = [];

  for (const [tokenId, { buys, sells }] of Object.entries(byToken)) {
    if (buys.length === 0) continue;
    const totalBuyShares = buys.reduce((s, f) => s + f.size, 0);
    const totalBuyCost = buys.reduce((s, f) => s + f.price * f.size, 0);
    const avgBuyPrice = totalBuyCost / totalBuyShares;

    if (sells.length === 0) { openTrades++; continue; }

    const totalSellShares = sells.reduce((s, f) => s + f.size, 0);
    const totalSellRevenue = sells.reduce((s, f) => s + f.price * f.size, 0);
    const avgSellPrice = totalSellRevenue / totalSellShares;

    // Realized PnL on the sold portion
    const closedSize = Math.min(totalBuyShares, totalSellShares);
    const pnl = (avgSellPrice - avgBuyPrice) * closedSize;
    const win = pnl > 0;
    const band = getBand(avgBuyPrice);

    bands[band][win ? 'wins' : 'losses']++;
    bands[band].pnl += pnl;
    closedTrades++;
    tradeDetails.push({ tokenId: tokenId.slice(0,10), avgBuyPrice: avgBuyPrice.toFixed(4), avgSellPrice: avgSellPrice.toFixed(4), pnl: pnl.toFixed(3), win });
  }

  console.log(`\n=== ${profileId.toUpperCase()} — Entry Price Band Analysis ===`);
  console.log(`Closed trades: ${closedTrades} | Still open: ${openTrades}`);
  console.log(`\n  Band       | Trades | Win% | Total PnL`);
  console.log(`  -----------|--------|------|----------`);
  for (const [band, { wins, losses, pnl }] of Object.entries(bands)) {
    const total = wins + losses;
    if (total === 0) continue;
    const winPct = ((wins / total) * 100).toFixed(0);
    console.log(`  ${band}  |  ${String(total).padStart(4)}  | ${String(winPct).padStart(3)}% | $${pnl.toFixed(2)}`);
  }

  const totalWins = tradeDetails.filter(t => t.win).length;
  const totalPnl = tradeDetails.reduce((s, t) => s + parseFloat(t.pnl), 0);
  console.log(`\n  Overall: ${totalWins}/${closedTrades} wins (${((totalWins/closedTrades)*100).toFixed(0)}%) | Total realized PnL: $${totalPnl.toFixed(2)}`);
}

async function main() {
  await analyseProfile('live');
  await analyseProfile('paper-v2');
}

main().catch(e => console.error(e.message)).finally(() => db.$disconnect());
