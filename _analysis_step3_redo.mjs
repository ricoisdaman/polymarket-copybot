// Step 3 redo: proper P&L breakdown by sport using slug-based classification
// Chain: Fill → Order → CopyIntent → LeaderEvent (for slug)
import path from 'path';
import { fileURLToPath } from 'url';
import { PrismaClient } from './packages/db/node_modules/@prisma/client/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbUrl = 'file:' + path.resolve(__dirname, './packages/db/prisma/dev.db').replace(/\\/g, '/');
const prisma = new PrismaClient({ datasources: { db: { url: dbUrl } } });

function classifySport(slug) {
  if (!slug) return 'unknown';
  const s = slug.toLowerCase();
  if (s.startsWith('mlb-')) return 'MLB';
  if (s.startsWith('nba-')) return 'NBA';
  if (s.startsWith('nfl-')) return 'NFL';
  if (s.startsWith('nhl-')) return 'NHL';
  if (s.startsWith('ncaab-') || s.startsWith('cbb-')) return 'NCAA_BB';
  if (s.startsWith('ncaaf-')) return 'NCAAF';
  if (s.startsWith('soccer-') || s.startsWith('epl-') || s.startsWith('mls-') || s.startsWith('laliga-') || s.startsWith('ucl-')) return 'Soccer';
  if (s.startsWith('tennis-') || s.startsWith('atp-') || s.startsWith('wta-')) return 'Tennis';
  if (s.startsWith('boxing-') || s.startsWith('mma-') || s.startsWith('ufc-')) return 'Combat';
  return s.split('-')[0] || 'unknown';
}

// Use raw SQL to join: Fill → Order → CopyIntent → LeaderEvent (for BUY intents only)
// SELL intents use synthetic leaderEventIds that don't exist in LeaderEvent
// Strategy: build tokenId→sport map from BUY intents, then join with ALL fills by tokenId

// Step 1: Get sport for each (profileId, tokenId) from BUY intents
const buyIntentSlugs = await prisma.$queryRawUnsafe(`
  SELECT ci.profileId, ci.tokenId, le.rawJson
  FROM CopyIntent ci
  JOIN LeaderEvent le ON ci.leaderEventId = le.id
  WHERE ci.side = 'BUY' AND ci.profileId IN ('live', 'paper-v2')
`);

const tokenSportMap = new Map();
for (const r of buyIntentSlugs) {
  const rj = r.rawJson ? JSON.parse(r.rawJson) : {};
  const slug = rj.slug || rj.eventSlug || '';
  const sport = classifySport(slug);
  tokenSportMap.set(`${r.profileId}::${r.tokenId}`, sport);
}
console.log(`Unique (profile,tokenId) sport mappings: ${tokenSportMap.size}`);

// Step 2: Get ALL fills (BUY and SELL) with side from Order
const rawFills = await prisma.$queryRawUnsafe(`
  SELECT 
    f.profileId,
    f.price,
    f.size,
    o.side,
    ci.tokenId
  FROM Fill f
  JOIN "Order" o ON f.orderId = o.id
  JOIN CopyIntent ci ON o.intentId = ci.id
  WHERE f.profileId IN ('live', 'paper-v2')
`);

await prisma.$disconnect();

console.log(`Total fills loaded: ${rawFills.length}`);

// Step 3: Compute per-(profile,tokenId) P&L
const tradeMap = new Map(); // key = `${profileId}::${tokenId}`

for (const fill of rawFills) {
  const sport = tokenSportMap.get(`${fill.profileId}::${fill.tokenId}`) || classifySport('');
  const key = `${fill.profileId}::${fill.tokenId}`;
  
  if (!tradeMap.has(key)) {
    tradeMap.set(key, {
      profileId: fill.profileId,
      tokenId: fill.tokenId,
      sport,
      buyCost: 0,   // USDC spent
      sellRevenue: 0, // USDC received
      buyShares: 0,
      sellShares: 0,
    });
  }
  
  const t = tradeMap.get(key);
  const usdcValue = fill.price * fill.size;
  
  if (fill.side === 'BUY') {
    t.buyCost += usdcValue;
    t.buyShares += fill.size;
  } else if (fill.side === 'SELL') {
    t.sellRevenue += usdcValue;
    t.sellShares += fill.size;
  }
}

// Compute sport-level P&L
// A trade is "resolved" if it has SELL fills (paper-v2 copies leader sells)
// For live, positions are settled on-chain — we can only see the cost basis

const sportStats = {}; // key = `${profile}::${sport}`

for (const [, trade] of tradeMap) {
  const key = `${trade.profileId}::${trade.sport}`;
  if (!sportStats[key]) {
    sportStats[key] = { profile: trade.profileId, sport: trade.sport, trades: 0, resolved: 0, wins: 0, losses: 0, pnl: 0, totalCost: 0 };
  }
  const stat = sportStats[key];
  stat.trades++;
  stat.totalCost += trade.buyCost;
  
  if (trade.sellShares > 0) {
    // Resolved trade
    const pnl = trade.sellRevenue - trade.buyCost;
    stat.resolved++;
    stat.pnl += pnl;
    if (pnl > 0) stat.wins++;
    else stat.losses++;
  }
}

// Print results
for (const profile of ['live', 'paper-v2']) {
  const keys = Object.keys(sportStats).filter(k => k.startsWith(profile + '::'));
  const rows = keys.map(k => sportStats[k]);
  rows.sort((a, b) => b.trades - a.trades);

  console.log(`\n=== ${profile} — Sport P&L (slug-based, accurate) ===\n`);
  console.log(`${'Sport'.padEnd(10)} ${'Trades'.padStart(7)} ${'Resolved'.padStart(9)} ${'Wins'.padStart(5)} ${'Losses'.padStart(7)} ${'Win%'.padStart(6)} ${'P&L'.padStart(10)} ${'Cost'.padStart(10)}`);
  console.log('-'.repeat(72));

  let tTrades = 0, tResolved = 0, tWins = 0, tLoss = 0, tPnl = 0, tCost = 0;
  for (const r of rows) {
    const winPct = r.resolved > 0 ? ((r.wins / r.resolved) * 100).toFixed(0) + '%' : '-';
    console.log(
      `${r.sport.padEnd(10)} ${String(r.trades).padStart(7)} ${String(r.resolved).padStart(9)} ${String(r.wins).padStart(5)} ${String(r.losses).padStart(7)} ${winPct.padStart(6)} ${('$' + r.pnl.toFixed(2)).padStart(10)} ${('$' + r.totalCost.toFixed(2)).padStart(10)}`
    );
    tTrades += r.trades; tResolved += r.resolved; tWins += r.wins; tLoss += r.losses; tPnl += r.pnl; tCost += r.totalCost;
  }
  console.log('-'.repeat(72));
  const totalWinPct = tResolved > 0 ? ((tWins / tResolved) * 100).toFixed(0) + '%' : '-';
  console.log(
    `${'TOTAL'.padEnd(10)} ${String(tTrades).padStart(7)} ${String(tResolved).padStart(9)} ${String(tWins).padStart(5)} ${String(tLoss).padStart(7)} ${totalWinPct.padStart(6)} ${('$' + tPnl.toFixed(2)).padStart(10)} ${('$' + tCost.toFixed(2)).padStart(10)}`
  );
  
  if (profile === 'live') {
    console.log(`\n  Note: live has 0 SELL fills (holds to on-chain resolution).`);
    console.log(`  Cost basis by sport shows where capital was deployed.`);
  }
}
