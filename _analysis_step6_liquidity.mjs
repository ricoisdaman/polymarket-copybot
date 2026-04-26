// STEP 6: Liquidity at entry (proxy analysis)
// We don't store orderbook depth, but we can proxy liquidity via:
// 1. Slippage: fill.price vs order.price
// 2. Partial fill rate: fill.size vs order.size
// 3. liquiditySide: TAKER = liquid (we crossed spread), MAKER = illiquid (we rested)
// 4. Leader bet size as a liquidity signal (big bets = liquid markets)
import path from 'path';
import { fileURLToPath } from 'url';
import { PrismaClient } from './packages/db/node_modules/@prisma/client/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbUrl = 'file:' + path.resolve(__dirname, './packages/db/prisma/dev.db').replace(/\\/g, '/');
const db = new PrismaClient({ datasources: { db: { url: dbUrl } } });

async function analyseProfile(profileId) {
  const fills = await db.fill.findMany({
    where: { profileId },
    select: { id: true, orderId: true, price: true, size: true, fee: true, liquiditySide: true }
  });
  const orders = await db.order.findMany({
    where: { profileId },
    select: { id: true, intentId: true, price: true, size: true }
  });
  const intents = await db.copyIntent.findMany({
    where: { profileId, status: { in: ['FILLED', 'SETTLED'] } },
    select: { id: true, tokenId: true, side: true, leaderSize: true, desiredSize: true, desiredNotional: true }
  });

  const orderMap = new Map(orders.map(o => [o.id, o]));
  const intentMap = new Map(intents.map(i => [i.id, i]));

  // Get p&l per token for paper-v2
  const pnlByToken = {};
  if (profileId === 'paper-v2') {
    const allIntents = await db.copyIntent.findMany({ where: { profileId }, select: { id: true, tokenId: true, side: true } });
    const intentMapAll = new Map(allIntents.map(i => [i.id, i]));
    const byToken = {};
    for (const f of fills) {
      const order = orderMap.get(f.orderId);
      if (!order) continue;
      const intent = intentMapAll.get(order.intentId);
      if (!intent) continue;
      const t = intent.tokenId;
      if (!byToken[t]) byToken[t] = { buyCost: 0, buyShares: 0, sellRev: 0, sellShares: 0 };
      if (intent.side === 'BUY') { byToken[t].buyCost += f.price * f.size; byToken[t].buyShares += f.size; }
      else { byToken[t].sellRev += f.price * f.size; byToken[t].sellShares += f.size; }
    }
    for (const [t, d] of Object.entries(byToken)) {
      if (d.buyShares === 0 || d.sellShares === 0) continue;
      pnlByToken[t] = (d.sellRev / d.sellShares - d.buyCost / d.buyShares) * Math.min(d.buyShares, d.sellShares);
    }
  }

  // Only look at BUY fills for liquidity analysis
  const buyData = [];
  for (const f of fills) {
    const order = orderMap.get(f.orderId);
    if (!order) continue;
    const intent = intentMap.get(order.intentId);
    if (!intent || intent.side !== 'BUY') continue;
    const slippageBps = order.price > 0 ? ((f.price - order.price) / order.price) * 10000 : 0;
    const fillPct = order.size > 0 ? (f.size / order.size) * 100 : 100;
    buyData.push({
      tokenId: intent.tokenId,
      orderPrice: order.price,
      fillPrice: f.price,
      orderSize: order.size,
      fillSize: f.size,
      slippageBps,
      fillPct,
      liquiditySide: f.liquiditySide,
      leaderSize: intent.leaderSize ?? 0,
      pnl: pnlByToken[intent.tokenId] ?? null
    });
  }

  console.log(`\n===== STEP 6: ${profileId.toUpperCase()} — LIQUIDITY AT ENTRY =====`);
  console.log(`  BUY fills analysed: ${buyData.length}`);

  // 1. Liquidity side breakdown
  const takerFills = buyData.filter(d => d.liquiditySide === 'TAKER');
  const makerFills = buyData.filter(d => d.liquiditySide === 'MAKER');
  console.log(`\n── 1. Fill type (TAKER = crossed spread, MAKER = rested order) ──`);
  console.log(`  TAKER: ${takerFills.length} (${((takerFills.length / buyData.length) * 100).toFixed(0)}%)`);
  console.log(`  MAKER: ${makerFills.length} (${((makerFills.length / buyData.length) * 100).toFixed(0)}%)`);

  // 2. Slippage distribution
  const slippages = buyData.map(d => d.slippageBps).filter(s => Math.abs(s) < 1000); // exclude outliers
  slippages.sort((a, b) => a - b);
  const avgSlip = slippages.reduce((s, v) => s + v, 0) / slippages.length;
  const medSlip = slippages[Math.floor(slippages.length / 2)];
  const negSlip = slippages.filter(s => s < 0).length;
  const zeroSlip = slippages.filter(s => s === 0).length;
  const posSlip = slippages.filter(s => s > 0).length;
  console.log(`\n── 2. Slippage (fill price vs order price) ──`);
  console.log(`  Avg: ${avgSlip.toFixed(1)} bps | Median: ${medSlip.toFixed(1)} bps`);
  console.log(`  Favourable (negative): ${negSlip} | Zero: ${zeroSlip} | Adverse (positive): ${posSlip}`);

  // 3. Partial fill analysis
  const fullFills = buyData.filter(d => d.fillPct >= 99);
  const partialFills = buyData.filter(d => d.fillPct < 99);
  console.log(`\n── 3. Partial fills (thin liquidity indicator) ──`);
  console.log(`  Full fills (>=99%): ${fullFills.length} (${((fullFills.length / buyData.length) * 100).toFixed(0)}%)`);
  console.log(`  Partial fills (<99%): ${partialFills.length} (${((partialFills.length / buyData.length) * 100).toFixed(0)}%)`);
  if (partialFills.length > 0) {
    const avgPartialPct = partialFills.reduce((s, d) => s + d.fillPct, 0) / partialFills.length;
    console.log(`  Avg partial fill %: ${avgPartialPct.toFixed(1)}%`);
  }

  // 4. For paper-v2: does slippage predict outcome?
  if (profileId === 'paper-v2') {
    const withPnl = buyData.filter(d => d.pnl !== null);
    const wins = withPnl.filter(d => d.pnl > 0);
    const losses = withPnl.filter(d => d.pnl <= 0);
    const avgSlipWin = wins.length ? wins.reduce((s, d) => s + d.slippageBps, 0) / wins.length : 0;
    const avgSlipLoss = losses.length ? losses.reduce((s, d) => s + d.slippageBps, 0) / losses.length : 0;
    const avgLsWin = wins.length ? wins.reduce((s, d) => s + d.leaderSize, 0) / wins.length : 0;
    const avgLsLoss = losses.length ? losses.reduce((s, d) => s + d.leaderSize, 0) / losses.length : 0;
    console.log(`\n── 4. Liquidity vs outcome (paper-v2 only) ──`);
    console.log(`  Winning trades (${wins.length}): avg slippage=${avgSlipWin.toFixed(1)} bps | avg leader size=$${avgLsWin.toFixed(2)}`);
    console.log(`  Losing trades  (${losses.length}): avg slippage=${avgSlipLoss.toFixed(1)} bps | avg leader size=$${avgLsLoss.toFixed(2)}`);

    // Slippage buckets vs win rate
    const slipBuckets = {
      'negative (<0 bps)':   { min: -9999, max: 0,   wins: 0, losses: 0 },
      'zero (0 bps)':        { min: 0,     max: 1,   wins: 0, losses: 0 },
      'low (1-20 bps)':      { min: 1,     max: 20,  wins: 0, losses: 0 },
      'med (20-100 bps)':    { min: 20,    max: 100, wins: 0, losses: 0 },
      'high (100+ bps)':     { min: 100,   max: 9999,wins: 0, losses: 0 },
    };
    for (const d of withPnl) {
      for (const [, b] of Object.entries(slipBuckets)) {
        if (d.slippageBps >= b.min && d.slippageBps < b.max) {
          if (d.pnl > 0) b.wins++; else b.losses++;
          break;
        }
      }
    }
    console.log(`\n  Slippage bucket     | Win% | Trades`);
    console.log(`  --------------------|------|-------`);
    for (const [label, b] of Object.entries(slipBuckets)) {
      const total = b.wins + b.losses;
      if (total === 0) continue;
      const wp = ((b.wins / total) * 100).toFixed(0);
      console.log(`  ${label.padEnd(19)} | ${wp.padStart(3)}% |  ${total}`);
    }
  }

  // 5. Existing liquidity filter — are we hitting the filter or sailing through?
  console.log(`\n── 5. Notes on existing filters ──`);
  console.log(`  Config: excludeLowLiquidityMarkets=true, maxSpreadBps=1500`);
  console.log(`  These filters run pre-trade at signal time, not recorded in DB`);
  console.log(`  Best proxy we have: partial fill rate + slippage above`);
}

async function main() {
  await analyseProfile('live');
  await analyseProfile('paper-v2');
}

main().catch(e => console.error(e.message)).finally(() => db.$disconnect());
