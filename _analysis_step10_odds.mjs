// STEP 10: Odds movement — buy price vs sell price on paper-v2
// Strong wins = market moved quickly in our favour (price rose before sell)
// A rising sell price vs buy price = market "catching up" to the leader's view
import path from 'path';
import { fileURLToPath } from 'url';
import { PrismaClient } from './packages/db/node_modules/@prisma/client/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbUrl = 'file:' + path.resolve(__dirname, './packages/db/prisma/dev.db').replace(/\\/g, '/');
const db = new PrismaClient({ datasources: { db: { url: dbUrl } } });

async function main() {
  const fills = await db.fill.findMany({
    where: { profileId: 'paper-v2' },
    select: { orderId: true, price: true, size: true, ts: true }
  });
  const orders = await db.order.findMany({
    where: { profileId: 'paper-v2' },
    select: { id: true, intentId: true }
  });
  const intents = await db.copyIntent.findMany({
    where: { profileId: 'paper-v2' },
    select: { id: true, tokenId: true, side: true, ts: true, leaderEventId: true }
  });

  const orderMap = new Map(orders.map(o => [o.id, o.intentId]));
  const intentMap = new Map(intents.map(i => [i.id, i]));

  // Build per-token: avgBuyPrice, avgSellPrice, buyTs, sellTs
  const byToken = {};
  for (const f of fills) {
    const iid = orderMap.get(f.orderId);
    const intent = iid ? intentMap.get(iid) : null;
    if (!intent) continue;
    const t = intent.tokenId;
    if (!byToken[t]) byToken[t] = { bc: 0, bs: 0, sc: 0, ss: 0, buyTs: null, sellTs: null };
    if (intent.side === 'BUY') {
      byToken[t].bc += f.price * f.size;
      byToken[t].bs += f.size;
      if (!byToken[t].buyTs || new Date(f.ts) < new Date(byToken[t].buyTs)) byToken[t].buyTs = f.ts;
    } else {
      byToken[t].sc += f.price * f.size;
      byToken[t].ss += f.size;
      if (!byToken[t].sellTs || new Date(f.ts) > new Date(byToken[t].sellTs)) byToken[t].sellTs = f.ts;
    }
  }

  // Get market titles
  const intentIds = intents.map(i => i.id);
  const leIds = intents.map(i => i.leaderEventId).filter(Boolean);
  const leEvents = await db.leaderEvent.findMany({
    where: { id: { in: leIds } },
    select: { id: true, rawJson: true }
  });
  const titleByLeId = new Map();
  for (const ev of leEvents) {
    try { titleByLeId.set(ev.id, JSON.parse(ev.rawJson).title || ''); } catch { titleByLeId.set(ev.id, ''); }
  }
  // map tokenId → title via intent
  const titleByToken = new Map();
  for (const intent of intents) {
    if (!titleByToken.has(intent.tokenId) && intent.leaderEventId) {
      const t = titleByLeId.get(intent.leaderEventId);
      if (t) titleByToken.set(intent.tokenId, t);
    }
  }

  // Build trade list
  const trades = [];
  for (const [tokenId, d] of Object.entries(byToken)) {
    if (d.bs === 0 || d.ss === 0) continue;
    const avgBuy = d.bc / d.bs;
    const avgSell = d.sc / d.ss;
    const move = avgSell - avgBuy; // price movement in our favour
    const movePct = (move / avgBuy) * 100;
    const pnl = move * Math.min(d.bs, d.ss);
    const holdHours = d.buyTs && d.sellTs ? (new Date(d.sellTs) - new Date(d.buyTs)) / 3600000 : null;
    trades.push({ tokenId, avgBuy, avgSell, move, movePct, pnl, holdHours, title: titleByToken.get(tokenId) || '' });
  }
  trades.sort((a, b) => b.movePct - a.movePct);

  console.log('===== STEP 10: ODDS MOVEMENT (PAPER-V2) =====');
  console.log(`Closed trades with buy+sell: ${trades.length}`);

  // Movement distribution
  const strongWin  = trades.filter(t => t.movePct >= 20);   // bought 0.75 sold 0.95+
  const modWin     = trades.filter(t => t.movePct >= 5 && t.movePct < 20);
  const flatWin    = trades.filter(t => t.movePct >= 0 && t.movePct < 5);
  const smallLoss  = trades.filter(t => t.movePct < 0 && t.movePct >= -15);
  const bigLoss    = trades.filter(t => t.movePct < -15);   // 0.001 resolution

  console.log('\n── Price Movement Buckets ──');
  console.log('  Movement          | Trades |  Avg PnL | Avg Move');
  console.log('  ------------------|--------|----------|----------');
  for (const [label, group] of [
    ['Strong win (>+20%)',  strongWin],
    ['Mod win (+5-20%)',    modWin],
    ['Flat win (0-5%)',     flatWin],
    ['Small loss (-15-0%)', smallLoss],
    ['Full loss (<-15%)',   bigLoss],
  ]) {
    if (group.length === 0) continue;
    const avgPnl = group.reduce((s, t) => s + t.pnl, 0) / group.length;
    const avgMove = group.reduce((s, t) => s + t.movePct, 0) / group.length;
    console.log(`  ${label.padEnd(17)} |   ${String(group.length).padStart(3)}  |  $${avgPnl.toFixed(2).padStart(6)} | ${avgMove.toFixed(1)}%`);
  }

  // Hold time vs outcome
  const withTime = trades.filter(t => t.holdHours !== null && t.holdHours > 0);
  const wins = withTime.filter(t => t.pnl > 0);
  const losses = withTime.filter(t => t.pnl <= 0);
  const avgHoldWin  = wins.length ? wins.reduce((s, t) => s + t.holdHours, 0) / wins.length : 0;
  const avgHoldLoss = losses.length ? losses.reduce((s, t) => s + t.holdHours, 0) / losses.length : 0;
  console.log('\n── Hold Time vs Outcome ──');
  console.log(`  Winning trades: avg hold ${avgHoldWin.toFixed(1)}h`);
  console.log(`  Losing trades:  avg hold ${avgHoldLoss.toFixed(1)}h`);

  // Buy price vs sell price correlation
  console.log('\n── Entry price vs Exit price patterns ──');
  const winsDetail = trades.filter(t => t.pnl > 0).sort((a, b) => b.pnl - a.pnl).slice(0, 8);
  console.log('  Top 8 winners: buy→sell | move | PnL');
  for (const t of winsDetail) {
    console.log(`    $${t.avgBuy.toFixed(3)}→$${t.avgSell.toFixed(3)}  +${t.movePct.toFixed(1)}%  $${t.pnl.toFixed(2)}  "${t.title.slice(0,50)}"`);
  }
  const lossesDetail = trades.filter(t => t.pnl <= 0).sort((a, b) => a.pnl - b.pnl).slice(0, 8);
  console.log('  Bottom 8 losers: buy→sell | move | PnL');
  for (const t of lossesDetail) {
    console.log(`    $${t.avgBuy.toFixed(3)}→$${t.avgSell.toFixed(3)}  ${t.movePct.toFixed(1)}%  $${t.pnl.toFixed(2)}  "${t.title.slice(0,50)}"`);
  }

  // Key stat: what % of wins resolved at $0.99-1.00 (market went fully YES)
  const resolvedYes = trades.filter(t => t.avgSell >= 0.99 && t.pnl > 0);
  const resolvedNo  = trades.filter(t => t.avgSell <= 0.01 && t.pnl <= 0);
  const leaderSoldMid = trades.filter(t => t.avgSell > 0.01 && t.avgSell < 0.99);
  console.log('\n── How positions closed ──');
  console.log(`  Resolved YES (sold @$0.99-1.00): ${resolvedYes.length} (${((resolvedYes.length/trades.length)*100).toFixed(0)}%)`);
  console.log(`  Resolved NO  (sold @$0.00-0.01): ${resolvedNo.length} (${((resolvedNo.length/trades.length)*100).toFixed(0)}%)`);
  console.log(`  Leader sold mid-market (0.01-0.99): ${leaderSoldMid.length} (${((leaderSoldMid.length/trades.length)*100).toFixed(0)}%)`);

  const midWins = leaderSoldMid.filter(t => t.pnl > 0);
  const midLosses = leaderSoldMid.filter(t => t.pnl <= 0);
  if (leaderSoldMid.length > 0) {
    const avgMidPnl = leaderSoldMid.reduce((s, t) => s + t.pnl, 0) / leaderSoldMid.length;
    console.log(`    Of mid-market closes: ${midWins.length}W / ${midLosses.length}L | avg PnL $${avgMidPnl.toFixed(2)}`);
    console.log(`    Sample mid-market exits:`);
    for (const t of leaderSoldMid.slice(0, 5)) {
      console.log(`      $${t.avgBuy.toFixed(3)}→$${t.avgSell.toFixed(3)}  PnL: $${t.pnl.toFixed(2)}  "${t.title.slice(0,50)}"`);
    }
  }
}

main().catch(e => console.error(e.message)).finally(() => db.$disconnect());
