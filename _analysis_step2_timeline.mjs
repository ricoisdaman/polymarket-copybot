// STEP 2: P&L timeline for live and paper-v2
// Reconstruct running P&L over time using fill timestamps
import path from 'path';
import { fileURLToPath } from 'url';
import { PrismaClient } from './packages/db/node_modules/@prisma/client/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbUrl = 'file:' + path.resolve(__dirname, './packages/db/prisma/dev.db').replace(/\\/g, '/');
const db = new PrismaClient({ datasources: { db: { url: dbUrl } } });

async function buildTimeline(profileId, startCash, holdToResolution) {
  const fills = await db.fill.findMany({
    where: { profileId },
    select: { orderId: true, price: true, size: true, ts: true },
    orderBy: { ts: 'asc' }
  });
  const orders = await db.order.findMany({ where: { profileId }, select: { id: true, intentId: true } });
  const intents = await db.copyIntent.findMany({ where: { profileId }, select: { id: true, tokenId: true, side: true } });
  const orderMap = new Map(orders.map(o => [o.id, o.intentId]));
  const intentMap = new Map(intents.map(i => [i.id, i]));

  // For hold-to-resolution (live): track only BUY fills, estimate P&L from cash flow
  // For paper-v2: track BUY and SELL fills to get direct running P&L
  let cash = startCash;
  const events = [];

  if (holdToResolution) {
    // For live: just track cash outflows (BUYs). Inflows (resolution payouts) aren't individually timestamped.
    // Instead: group by week and show cumulative spend vs position value
    for (const f of fills) {
      const iid = orderMap.get(f.orderId);
      const intent = iid ? intentMap.get(iid) : null;
      if (!intent || intent.side !== 'BUY') continue;
      cash -= f.price * f.size;
      events.push({ ts: f.ts, cash, type: 'BUY', price: f.price, size: f.size, tokenId: intent.tokenId });
    }
    return events;
  }

  // paper-v2: track BUY and SELL fills for running P&L
  // Build per-token cost basis first
  const costBasis = {};
  for (const f of fills) {
    const iid = orderMap.get(f.orderId);
    const intent = iid ? intentMap.get(iid) : null;
    if (!intent) continue;
    const t = intent.tokenId;
    if (!costBasis[t]) costBasis[t] = { shares: 0, cost: 0, buys: [], sells: [] };
    if (intent.side === 'BUY') {
      costBasis[t].buys.push({ price: f.price, size: f.size, ts: f.ts });
    } else {
      costBasis[t].sells.push({ price: f.price, size: f.size, ts: f.ts });
    }
  }

  // Build event stream: BUY = open position, SELL = close + realize P&L
  const eventStream = [];
  for (const [tokenId, data] of Object.entries(costBasis)) {
    for (const b of data.buys) eventStream.push({ ts: b.ts, side: 'BUY', price: b.price, size: b.size, tokenId });
    for (const s of data.sells) eventStream.push({ ts: s.ts, side: 'SELL', price: s.price, size: s.size, tokenId });
  }
  eventStream.sort((a, b) => new Date(a.ts) - new Date(b.ts));

  const openPositions = {};
  let realizedPnl = 0;
  const timeline = [];

  for (const ev of eventStream) {
    const t = ev.tokenId;
    if (ev.side === 'BUY') {
      if (!openPositions[t]) openPositions[t] = { cost: 0, shares: 0 };
      openPositions[t].shares += ev.size;
      openPositions[t].cost += ev.price * ev.size;
    } else {
      const pos = openPositions[t];
      if (!pos || pos.shares === 0) continue;
      const avgBuy = pos.cost / pos.shares;
      const closeSize = Math.min(pos.shares, ev.size);
      const pnl = (ev.price - avgBuy) * closeSize;
      realizedPnl += pnl;
      pos.shares -= closeSize;
      pos.cost -= avgBuy * closeSize;
      timeline.push({ ts: ev.ts, pnl, cumPnl: realizedPnl, win: pnl > 0, price: ev.price, avgBuy, tokenId: t });
    }
  }
  return timeline;
}

async function main() {
  // Paper-v2 timeline
  const v2Timeline = await buildTimeline('paper-v2', 60, false);

  // Group by day for display
  const dailyPnl = {};
  for (const ev of v2Timeline) {
    const day = new Date(ev.ts).toISOString().slice(0, 10);
    if (!dailyPnl[day]) dailyPnl[day] = { pnl: 0, wins: 0, losses: 0 };
    dailyPnl[day].pnl += ev.pnl;
    dailyPnl[day][ev.win ? 'wins' : 'losses']++;
  }

  console.log('\n===== STEP 2: P&L TIMELINE =====');
  console.log('\n── PAPER-V2 Daily P&L (closed trades) ──');
  console.log(`  Date       | Day PnL  | W/L | Cumul PnL`);
  console.log(`  -----------|----------|-----|----------`);
  let cumPnl = 0;
  let peakPnl = 0;
  let peakDate = '';
  for (const [day, { pnl, wins, losses }] of Object.entries(dailyPnl).sort()) {
    cumPnl += pnl;
    if (cumPnl > peakPnl) { peakPnl = cumPnl; peakDate = day; }
    const sign = pnl >= 0 ? '+' : '';
    console.log(`  ${day} | ${sign}${pnl.toFixed(2).padStart(7)} | ${wins}W/${losses}L | $${cumPnl.toFixed(2)}`);
  }
  console.log(`\n  Peak P&L: $${peakPnl.toFixed(2)} on ${peakDate}`);
  console.log(`  Current P&L: $${cumPnl.toFixed(2)}`);
  console.log(`  Drawdown from peak: -$${(peakPnl - cumPnl).toFixed(2)}`);

  // Show biggest losing trades
  const losses = v2Timeline.filter(e => !e.win).sort((a, b) => a.pnl - b.pnl).slice(0, 8);
  console.log('\n── PAPER-V2: Biggest Losing Trades ──');
  for (const l of losses) {
    console.log(`  ${new Date(l.ts).toISOString().slice(0,10)} bought@${l.avgBuy.toFixed(3)} sold@${l.price.toFixed(3)} P&L: $${l.pnl.toFixed(2)}`);
  }
  const wins = v2Timeline.filter(e => e.win).sort((a, b) => b.pnl - a.pnl).slice(0, 5);
  console.log('\n── PAPER-V2: Biggest Winning Trades ──');
  for (const w of wins) {
    console.log(`  ${new Date(w.ts).toISOString().slice(0,10)} bought@${w.avgBuy.toFixed(3)} sold@${w.price.toFixed(3)} P&L: $${w.pnl.toFixed(2)}`);
  }

  // Live: use fill timestamps to show activity by date and note peak/reversal
  const liveFills = await db.fill.findMany({
    where: { profileId: 'live' },
    select: { price: true, size: true, ts: true },
    orderBy: { ts: 'asc' }
  });
  const livePositions = await db.position.findMany({ where: { profileId: 'live' }, select: { tokenId: true, size: true, updatedAt: true } });
  const closedPositions = livePositions.filter(p => p.size <= 0).sort((a, b) => new Date(a.updatedAt) - new Date(b.updatedAt));

  // Group closures by day (when position was zeroed = when market resolved)
  const closedByDay = {};
  for (const p of closedPositions) {
    const day = new Date(p.updatedAt).toISOString().slice(0, 10);
    if (!closedByDay[day]) closedByDay[day] = 0;
    closedByDay[day]++;
  }
  const buysByDay = {};
  for (const f of liveFills) {
    const day = new Date(f.ts).toISOString().slice(0, 10);
    if (!buysByDay[day]) buysByDay[day] = { count: 0, cost: 0 };
    buysByDay[day].count++;
    buysByDay[day].cost += f.price * f.size;
  }

  console.log('\n── LIVE BOT: Activity by Day ──');
  console.log(`  Date       | Buys | Spend  | Positions Closed`);
  console.log(`  -----------|------|--------|------------------`);
  const allDays = new Set([...Object.keys(buysByDay), ...Object.keys(closedByDay)]);
  for (const day of Array.from(allDays).sort()) {
    const b = buysByDay[day];
    const c = closedByDay[day] ?? 0;
    if (b) console.log(`  ${day} |  ${String(b.count).padStart(3)} | $${b.cost.toFixed(2).padStart(5)} | ${c} closed`);
    else console.log(`  ${day} |    0 |  $0.00 | ${c} closed`);
  }
  console.log(`\n  Note: Live holds to resolution — closures = on-chain market resolutions`);
  console.log(`  Cash $60 → $58.88 net, but ~$28+ worth of $3 trades recycled through the account`);
}

main().catch(e => console.error(e.message)).finally(() => db.$disconnect());
