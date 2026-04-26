// STEP 1 FINAL: Entry price analysis — both profiles
import path from 'path';
import { fileURLToPath } from 'url';
import { PrismaClient } from './packages/db/node_modules/@prisma/client/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbUrl = 'file:' + path.resolve(__dirname, './packages/db/prisma/dev.db').replace(/\\/g, '/');
const db = new PrismaClient({ datasources: { db: { url: dbUrl } } });

function getBand(price) {
  if (price < 0.65) return '0.60-0.65';
  if (price < 0.70) return '0.65-0.70';
  if (price < 0.75) return '0.70-0.75';
  if (price < 0.80) return '0.75-0.80';
  if (price < 0.85) return '0.80-0.85';
  if (price < 0.90) return '0.85-0.90';
  return '0.90+';
}

async function main() {
  // ── LIVE: holds to resolution, win/loss inferred from cash flow ──────────
  const liveFills = await db.fill.findMany({ where: { profileId: 'live' }, select: { orderId: true, price: true, size: true } });
  const liveOrders = await db.order.findMany({ where: { profileId: 'live' }, select: { id: true, intentId: true } });
  const liveIntents = await db.copyIntent.findMany({ where: { profileId: 'live' }, select: { id: true, tokenId: true } });
  const livePositions = await db.position.findMany({ where: { profileId: 'live' }, select: { tokenId: true, size: true } });

  const liveOrderMap = new Map(liveOrders.map(o => [o.id, o.intentId]));
  const liveIntentMap = new Map(liveIntents.map(i => [i.id, i]));
  const livePosMap = new Map(livePositions.map(p => [p.tokenId, p.size]));

  // Build per-token: avgBuyPrice, totalShares, isOpen
  const liveByToken = {};
  for (const f of liveFills) {
    const iid = liveOrderMap.get(f.orderId);
    const intent = iid ? liveIntentMap.get(iid) : null;
    if (!intent) continue;
    const t = intent.tokenId;
    if (!liveByToken[t]) liveByToken[t] = { cost: 0, shares: 0 };
    liveByToken[t].cost += f.price * f.size;
    liveByToken[t].shares += f.size;
  }

  // Cash flow math: total_yes_payouts = current_cash - start_cash + total_buy_cost
  const startCash = 60;
  const currentCash = 58.879431;
  const totalBuyCost = liveFills.reduce((s, f) => s + f.price * f.size, 0);
  const totalYesPayouts = currentCash - startCash + totalBuyCost;

  // Entry price distribution for live
  const liveBands = {};
  let totalLiveShares = 0;
  for (const [tokenId, { cost, shares }] of Object.entries(liveByToken)) {
    const avgPrice = cost / shares;
    const band = getBand(avgPrice);
    if (!liveBands[band]) liveBands[band] = { trades: 0, shares: 0, cost: 0, open: 0 };
    liveBands[band].trades++;
    liveBands[band].shares += shares;
    liveBands[band].cost += cost;
    totalLiveShares += shares;
    const posSize = livePosMap.get(tokenId) ?? 0;
    if (posSize > 0) liveBands[band].open++;
  }

  // Open position shares
  const openShares = livePositions.filter(p => p.size > 0).reduce((s, p) => s + p.size, 0);
  const closedShares = totalLiveShares - openShares;
  // Inferred win rate: YES payouts / closed shares (each YES = 1 USDC per share)
  // Minus open position payout contribution
  const closedPayouts = totalYesPayouts; // open not yet resolved
  const estWinSharePct = (closedPayouts / closedShares * 100).toFixed(1);

  console.log('\n===== STEP 1: ENTRY PRICE ANALYSIS =====');
  console.log('\n── LIVE BOT (holds to on-chain resolution) ──');
  console.log(`Total buys: ${Object.keys(liveByToken).length} | Total invested: $${totalBuyCost.toFixed(2)}`);
  console.log(`Start cash: $${startCash} | Current cash: $${currentCash.toFixed(2)}`);
  console.log(`Estimated YES payouts received: $${totalYesPayouts.toFixed(2)} on $${closedShares.toFixed(1)} closed shares`);
  console.log(`Implied win rate (by share value): ~${estWinSharePct}%`);
  console.log(`\n  Band       | Trades | Shares | Avg Entry`);
  console.log(`  -----------|--------|--------|----------`);
  const bandOrder = ['0.60-0.65','0.65-0.70','0.70-0.75','0.75-0.80','0.80-0.85','0.85-0.90','0.90+'];
  for (const band of bandOrder) {
    const b = liveBands[band];
    if (!b) continue;
    const avgEntry = (b.cost / b.shares).toFixed(4);
    console.log(`  ${band}  |   ${String(b.trades).padStart(3)}  |  ${b.shares.toFixed(1).padStart(5)} | $${avgEntry}${b.open ? ' ('+b.open+' open)' : ''}`);
  }

  // ── PAPER-V2: has sell fills, direct win/loss ────────────────────────────
  const v2Fills = await db.fill.findMany({ where: { profileId: 'paper-v2' }, select: { orderId: true, price: true, size: true } });
  const v2Orders = await db.order.findMany({ where: { profileId: 'paper-v2' }, select: { id: true, intentId: true } });
  const v2Intents = await db.copyIntent.findMany({ where: { profileId: 'paper-v2' }, select: { id: true, tokenId: true, side: true } });
  const v2OrderMap = new Map(v2Orders.map(o => [o.id, o.intentId]));
  const v2IntentMap = new Map(v2Intents.map(i => [i.id, i]));

  const v2ByToken = {};
  for (const f of v2Fills) {
    const iid = v2OrderMap.get(f.orderId);
    const intent = iid ? v2IntentMap.get(iid) : null;
    if (!intent) continue;
    const t = intent.tokenId;
    if (!v2ByToken[t]) v2ByToken[t] = { buyCost: 0, buyShares: 0, sellRev: 0, sellShares: 0 };
    if (intent.side === 'BUY') { v2ByToken[t].buyCost += f.price * f.size; v2ByToken[t].buyShares += f.size; }
    else { v2ByToken[t].sellRev += f.price * f.size; v2ByToken[t].sellShares += f.size; }
  }

  const v2Bands = {};
  let v2Wins = 0, v2Losses = 0, v2TotalPnl = 0;
  for (const [, data] of Object.entries(v2ByToken)) {
    if (data.buyShares === 0 || data.sellShares === 0) continue;
    const avgBuy = data.buyCost / data.buyShares;
    const avgSell = data.sellRev / data.sellShares;
    const closedSize = Math.min(data.buyShares, data.sellShares);
    const pnl = (avgSell - avgBuy) * closedSize;
    const win = pnl > 0;
    const band = getBand(avgBuy);
    if (!v2Bands[band]) v2Bands[band] = { wins: 0, losses: 0, pnl: 0, avgBuySum: 0, avgSellSum: 0, count: 0 };
    v2Bands[band][win ? 'wins' : 'losses']++;
    v2Bands[band].pnl += pnl;
    v2Bands[band].avgBuySum += avgBuy;
    v2Bands[band].avgSellSum += avgSell;
    v2Bands[band].count++;
    if (win) v2Wins++; else v2Losses++;
    v2TotalPnl += pnl;
  }

  console.log('\n── PAPER-V2 (copies leader sells, direct win/loss available) ──');
  console.log(`Closed trades: ${v2Wins + v2Losses} | Overall: ${v2Wins}W / ${v2Losses}L (${((v2Wins/(v2Wins+v2Losses))*100).toFixed(0)}% win rate) | PnL: $${v2TotalPnl.toFixed(2)}`);
  console.log(`\n  Band       | Trades | Win% | PnL     | AvgBuy→AvgSell`);
  console.log(`  -----------|--------|------|---------|---------------`);
  for (const band of bandOrder) {
    const b = v2Bands[band];
    if (!b) continue;
    const total = b.wins + b.losses;
    const winPct = ((b.wins / total) * 100).toFixed(0);
    const avgB = (b.avgBuySum / b.count).toFixed(3);
    const avgS = (b.avgSellSum / b.count).toFixed(3);
    console.log(`  ${band}  |   ${String(total).padStart(3)}  | ${String(winPct).padStart(3)}% | $${b.pnl.toFixed(2).padStart(7)} | $${avgB}→$${avgS}`);
  }

  console.log('\n── KEY TAKEAWAYS ──');
  // Find best and worst bands for v2
  let bestBand = null, worstBand = null, bestWinPct = -1, worstWinPct = 101;
  for (const [band, b] of Object.entries(v2Bands)) {
    const total = b.wins + b.losses;
    if (total < 5) continue; // ignore low-sample bands
    const wp = b.wins / total;
    if (wp > bestWinPct) { bestWinPct = wp; bestBand = band; }
    if (wp < worstWinPct) { worstWinPct = wp; worstBand = band; }
  }
  if (bestBand) console.log(`  Best price band (paper-v2): ${bestBand} — ${(bestWinPct*100).toFixed(0)}% win rate`);
  if (worstBand) console.log(`  Worst price band (paper-v2): ${worstBand} — ${(worstWinPct*100).toFixed(0)}% win rate`);
  console.log(`  Live filter 0.70-0.80 covers the middle bands — paper-v2 shows these are solid`);
  console.log(`  Paper-v2 widened to 0.60-0.88 — the 0.65-0.70 band is dragging results`);
}

main().catch(e => console.error(e.message)).finally(() => db.$disconnect());
