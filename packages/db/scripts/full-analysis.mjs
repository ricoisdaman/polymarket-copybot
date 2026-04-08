/**
 * Full diagnostic: P&L, win/loss, copy rate, missed trades, paper vs live
 * Uses actual schema: CopyIntent, Fill, Order, Position, LeaderEvent, RuntimeMetric, ConfigVersion
 */
import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();

const SINCE_DAYS = 7;
const since = new Date(Date.now() - SINCE_DAYS * 24 * 60 * 60 * 1000);

function fmt(n)  { return (n >= 0 ? '+' : '') + Number(n).toFixed(4); }
function pct(a, b) { return b === 0 ? 'n/a' : ((a / b) * 100).toFixed(1) + '%'; }
function sep(label) {
  console.log('\n' + '═'.repeat(72));
  console.log('  ' + label);
  console.log('═'.repeat(72));
}

// ─── 1. ACTIVE CONFIG per profile ────────────────────────────────────────────
sep('1. ACTIVE CONFIG per profile');
for (const pid of ['live','paper-v2','paper-v3','paper-sports-b','paper-0xa82af']) {
  const cv = await p.configVersion.findFirst({ where: { profileId: pid, active: true } });
  if (!cv) { console.log(`  ${pid}: no active config`); continue; }
  let cfg;
  try { cfg = JSON.parse(cv.json); } catch { console.log(`  ${pid}: parse error`); continue; }
  const b = cfg.budget ?? {}, f = cfg.filters ?? {}, ex = cfg.execution ?? {};
  console.log(`  ${pid.padEnd(20)} perTrade=$${b.perTradeNotionalUSDC}  perMarket=$${b.maxNotionalPerMarketUSDC}  daily=$${b.maxDailyNotionalUSDC}  minP=${f.minPrice}  maxP=${f.maxPrice}  maxSlip=${ex.maxSlippageBps}bps`);
}

// ─── 2. RUNTIME METRICS (cash, daily notional) ───────────────────────────────
sep('2. RUNTIME METRICS — current state per profile');
for (const pid of ['live','paper-v2','paper-v3','paper-sports-b']) {
  const metrics = await p.runtimeMetric.findMany({ where: { profileId: pid } });
  const m = Object.fromEntries(metrics.map(r => [r.key, r.value]));
  console.log(`  ${pid.padEnd(20)} cash=$${Number(m['bot.cash_usdc']??0).toFixed(2)}  dailyNotional=$${Number(m['bot.daily_notional_usdc']??0).toFixed(2)}  drawdown=${m['bot.drawdown_usdc'] ? '$'+Number(m['bot.drawdown_usdc']).toFixed(2) : 'n/a'}`);
}

// ─── 3. FILL-LEVEL CASHFLOW per profile ──────────────────────────────────────
sep('3. FILL CASHFLOW — buys vs sells per profile (last 7 days)');
for (const pid of ['live','paper-v2','paper-v3','paper-sports-b']) {

  const orders = await p.order.findMany({
    where: { profileId: pid, ts: { gte: since } },
    select: { id: true, intentId: true, side: true }
  });
  const orderMap = new Map(orders.map(o => [o.id, o]));

  const intentIds = [...new Set(orders.map(o => o.intentId))];
  const intents = intentIds.length ? await p.copyIntent.findMany({
    where: { id: { in: intentIds } },
    select: { id: true, tokenId: true }
  }) : [];
  const intentMap = new Map(intents.map(i => [i.id, i]));

  const fills = await p.fill.findMany({
    where: { profileId: pid, ts: { gte: since } }
  });

  let buyNotional = 0, sellNotional = 0, buyCount = 0, sellCount = 0;
  const tokenPnl = new Map();

  for (const fill of fills) {
    const order = orderMap.get(fill.orderId);
    const intent = order ? intentMap.get(order.intentId) : null;
    const tokenId = intent?.tokenId ?? 'unknown';
    const side = order?.side ?? 'BUY';
    const notional = fill.price * fill.size;

    if (!tokenPnl.has(tokenId)) tokenPnl.set(tokenId, { cost: 0, proceeds: 0, buyCount: 0, sellCount: 0 });
    const t = tokenPnl.get(tokenId);

    if (side === 'BUY') {
      buyNotional += notional; buyCount++;
      t.cost += notional; t.buyCount++;
    } else {
      sellNotional += notional; sellCount++;
      t.proceeds += notional; t.sellCount++;
    }
  }

  let realizedPnl = 0, wins = 0, losses = 0;
  for (const [, t] of tokenPnl) {
    if (t.sellCount > 0 && t.buyCount > 0) {
      const pnl = t.proceeds - t.cost;
      realizedPnl += pnl;
      if (pnl >= 0) wins++; else losses++;
    }
  }

  console.log(`  ${pid.padEnd(20)} fills=${fills.length}  buys=${buyCount}  sells=${sellCount}  buyNotional=$${buyNotional.toFixed(2)}  sellNotional=$${sellNotional.toFixed(2)}`);
  console.log(`  ${''.padEnd(20)} closedTrades=${wins+losses}  wins=${wins}  losses=${losses}  winRate=${pct(wins,wins+losses)}  realizedPnL=${fmt(realizedPnl)}`);
}

// ─── 4. OPEN POSITIONS — current exposure ────────────────────────────────────
sep('4. OPEN POSITIONS — current exposure per profile');
for (const pid of ['live','paper-v2','paper-v3','paper-sports-b']) {
  const positions = await p.position.findMany({ where: { profileId: pid, size: { gt: 0.001 } } });
  if (!positions.length) { console.log(`  ${pid}: no open positions`); continue; }
  const tokenIds = positions.map(pos => pos.tokenId);
  const evs = await p.leaderEvent.findMany({
    where: { tokenId: { in: tokenIds } },
    select: { tokenId: true, rawJson: true },
    distinct: ['tokenId']
  });
  const titleMap = new Map();
  for (const ev of evs) {
    try {
      const raw = JSON.parse(ev.rawJson);
      titleMap.set(ev.tokenId, (raw.title ?? raw.question ?? raw.market_slug ?? '').substring(0, 45));
    } catch { titleMap.set(ev.tokenId, ev.tokenId.slice(0, 20)); }
  }

  let totalExposure = 0;
  console.log(`  [${pid}]`);
  for (const pos of positions) {
    const notional = pos.size * pos.avgPrice;
    totalExposure += notional;
    const title = (titleMap.get(pos.tokenId) ?? pos.tokenId.slice(0, 20)).padEnd(47);
    console.log(`    ${title} size=${pos.size.toFixed(4)}  avgCost=${pos.avgPrice.toFixed(4)}  notional=$${notional.toFixed(2)}`);
  }
  console.log(`    ${'TOTAL'.padEnd(47)} $${totalExposure.toFixed(2)}`);
}

// ─── 5. COPY RATE — leader buys vs live bot ──────────────────────────────────
sep('5. COPY RATE — leader buys vs live bot actions (last 7 days)');
const leaderBuys = await p.leaderEvent.findMany({
  where: { profileId: 'live', side: 'BUY', ts: { gte: since } }
});
const liveIntents = await p.copyIntent.findMany({
  where: { profileId: 'live', ts: { gte: since } }
});
const filled  = liveIntents.filter(i => i.status === 'FILLED');
const skipped = liveIntents.filter(i => i.status === 'SKIPPED');

const skipByReason = {};
skipped.forEach(s => { const r = s.reason ?? 'UNKNOWN'; skipByReason[r] = (skipByReason[r] ?? 0) + 1; });

const lbMap = new Map(leaderBuys.map(e => [e.id, e]));

console.log(`  Leader BUY events:   ${leaderBuys.length}`);
console.log(`  Filled:              ${filled.length}  (${pct(filled.length, leaderBuys.length)} of leader buys)`);
console.log(`  Skipped:             ${skipped.length}`);
console.log('  Skip breakdown:');
Object.entries(skipByReason).sort((a, b) => b[1] - a[1]).forEach(([r, c]) => {
  console.log(`    ${r.padEnd(42)} ${c}`);
});

// ─── 6. PRICE distribution — filled vs skipped ───────────────────────────────
sep('6. PRICE DISTRIBUTION — leader buys: filled vs skipped (live, 7d)');
const filledLeaderIds = new Set(filled.map(i => i.leaderEventId));
const priceBounds = [0, 0.5, 0.6, 0.7, 0.75, 0.8, 0.9, 1.01];
const labels = ['<50c','50-60c','60-70c','70-75c','75-80c','80-90c','>90c'];
const fillBkt = Array(7).fill(0), skipBkt = Array(7).fill(0), leaderBkt = Array(7).fill(0);

for (const ev of leaderBuys) {
  const i = priceBounds.findIndex((b, ix) => ev.price >= b && ev.price < priceBounds[ix + 1]);
  if (i < 0) continue;
  leaderBkt[i]++;
  if (filledLeaderIds.has(ev.id)) fillBkt[i]++;
  else skipBkt[i]++;
}
console.log('  Bucket        Leader  Filled  Skipped  CopyRate');
labels.forEach((l, i) => {
  console.log(`  ${l.padEnd(12)} ${String(leaderBkt[i]).padStart(5)}   ${String(fillBkt[i]).padStart(4)}   ${String(skipBkt[i]).padStart(5)}   ${pct(fillBkt[i], leaderBkt[i])}`);
});

// ─── 7. HIGH-CONFIDENCE skips 70-90c ─────────────────────────────────────────
sep('7. HIGH-CONFIDENCE skips (leader price 70-90c) — reasons & examples');
const highConfSkips = skipped.filter(s => {
  const ev = lbMap.get(s.leaderEventId);
  return ev && ev.price >= 0.70 && ev.price <= 0.90;
});
const hcByReason = {};
highConfSkips.forEach(s => { const r = s.reason ?? 'UNKNOWN'; hcByReason[r] = (hcByReason[r] ?? 0) + 1; });
console.log(`  Total 70-90c skips: ${highConfSkips.length}`);
Object.entries(hcByReason).sort((a, b) => b[1] - a[1]).forEach(([r, c]) => {
  console.log(`    ${r.padEnd(42)} ${c}`);
});
console.log('  Examples:');
for (const s of highConfSkips.slice(0, 5)) {
  const ev = lbMap.get(s.leaderEventId);
  if (!ev) continue;
  let title = '';
  try { title = (JSON.parse(ev.rawJson)?.title ?? '').substring(0, 40); } catch {}
  console.log(`    price=${ev.price.toFixed(3)}  size=${ev.size.toFixed(2)}  $${ev.usdcSize.toFixed(2)}  reason=${s.reason}  "${title}"`);
}

// ─── 8. LEADER sell exit prices ──────────────────────────────────────────────
sep('8. LEADER exit (SELL) price distribution (last 7 days)');
const leaderSells = await p.leaderEvent.findMany({
  where: { profileId: 'live', side: 'SELL', ts: { gte: since } }
});
const sellBounds = [0, 0.5, 0.7, 0.8, 0.9, 0.95, 1.01];
const sellLabels = ['<50c','50-70c','70-80c','80-90c','90-95c','>95c'];
const sellBkt = Array(6).fill(0);
leaderSells.forEach(e => {
  const i = sellBounds.findIndex((b, ix) => e.price >= b && e.price < sellBounds[ix + 1]);
  if (i >= 0) sellBkt[i]++;
});
console.log(`  Total leader sells: ${leaderSells.length}`);
sellLabels.forEach((l, i) => console.log(`  ${l.padEnd(10)} ${sellBkt[i].toString().padStart(4)}  (${pct(sellBkt[i], leaderSells.length)})`));

// ─── 9. LIVE closed trade P&L ranked ─────────────────────────────────────────
sep('9. LIVE — closed trade P&L ranked (last 7 days)');
const liveOrders = await p.order.findMany({
  where: { profileId: 'live', ts: { gte: since } },
  select: { id: true, intentId: true, side: true }
});
const liveOrderMap = new Map(liveOrders.map(o => [o.id, o]));
const liveIntentObjMap = new Map(
  (await p.copyIntent.findMany({ where: { profileId: 'live', ts: { gte: since } }, select: { id: true, tokenId: true } }))
  .map(i => [i.id, i])
);
const liveFills = await p.fill.findMany({ where: { profileId: 'live', ts: { gte: since } } });
const tokenCF = new Map();
for (const fill of liveFills) {
  const order = liveOrderMap.get(fill.orderId);
  const intent = order ? liveIntentObjMap.get(order.intentId) : null;
  const tokenId = intent?.tokenId;
  if (!tokenId) continue;
  if (!tokenCF.has(tokenId)) tokenCF.set(tokenId, { cost: 0, proceeds: 0 });
  const cf = tokenCF.get(tokenId);
  if (order.side === 'BUY') cf.cost += fill.price * fill.size;
  else cf.proceeds += fill.price * fill.size;
}
const allTokenIds2 = [...tokenCF.keys()];
const titleEvs2 = await p.leaderEvent.findMany({
  where: { tokenId: { in: allTokenIds2 } },
  select: { tokenId: true, rawJson: true }, distinct: ['tokenId']
});
const titleMap2 = new Map();
for (const ev of titleEvs2) {
  try { titleMap2.set(ev.tokenId, (JSON.parse(ev.rawJson)?.title ?? '').substring(0, 48)); } catch {}
}
const closed = [...tokenCF.entries()]
  .filter(([, cf]) => cf.proceeds > 0)
  .map(([tokenId, cf]) => ({ tokenId, pnl: cf.proceeds - cf.cost, title: titleMap2.get(tokenId) ?? tokenId.slice(0, 20) }))
  .sort((a, b) => a.pnl - b.pnl);

if (!closed.length) {
  console.log('  No closed trades yet (no sell fills)');
} else {
  console.log('  Worst losses:');
  closed.slice(0, 8).forEach(r => console.log(`    ${fmt(r.pnl).padStart(10)}  ${r.title}`));
  console.log('  Best wins:');
  closed.slice(-8).reverse().forEach(r => console.log(`    ${fmt(r.pnl).padStart(10)}  ${r.title}`));
}

// ─── 10. PAPER-SPORTS-B vs LIVE comparison ───────────────────────────────────
sep('10. PAPER-SPORTS-B filled vs live (what is sports-b copying that live misses?)');
const sportsIntents = await p.copyIntent.findMany({
  where: { profileId: 'paper-sports-b', status: 'FILLED', ts: { gte: since } }
});
const sportsIds = new Set(sportsIntents.map(i => i.leaderEventId));
const liveFilledIds = new Set(filled.map(i => i.leaderEventId));
const sportsOnlyIds = [...sportsIds].filter(id => !liveFilledIds.has(id));
const sportsOnlyMissReasons = {};
for (const id of sportsOnlyIds) {
  const si = skipped.find(s => s.leaderEventId === id);
  const r = si?.reason ?? 'NOT_IN_LIVE_DB';
  sportsOnlyMissReasons[r] = (sportsOnlyMissReasons[r] ?? 0) + 1;
}
console.log(`  paper-sports-b filled: ${sportsIntents.length}    live filled: ${filled.length}`);
console.log(`  In sports-b NOT in live: ${sportsOnlyIds.length}`);
if (Object.keys(sportsOnlyMissReasons).length) {
  console.log('  Reasons live skipped those:');
  Object.entries(sportsOnlyMissReasons).sort((a, b) => b[1] - a[1]).forEach(([r, c]) => {
    console.log(`    ${r.padEnd(42)} ${c}`);
  });
}

// ─── 11. PAPER-V2 vs LIVE ────────────────────────────────────────────────────
sep('11. PAPER-V2 filled vs live — missed trade reasons');
const v2Filled = await p.copyIntent.findMany({
  where: { profileId: 'paper-v2', status: 'FILLED', ts: { gte: since } }
});
const v2Ids = new Set(v2Filled.map(i => i.leaderEventId));
const v2OnlyIds = [...v2Ids].filter(id => !liveFilledIds.has(id));
const v2MissReasons = {};
for (const id of v2OnlyIds) {
  const si = skipped.find(s => s.leaderEventId === id);
  const r = si?.reason ?? 'NOT_IN_LIVE_DB';
  v2MissReasons[r] = (v2MissReasons[r] ?? 0) + 1;
}
console.log(`  paper-v2 filled: ${v2Filled.length}    live filled: ${filled.length}`);
console.log(`  In paper-v2 NOT in live: ${v2OnlyIds.length}`);
if (Object.keys(v2MissReasons).length) {
  Object.entries(v2MissReasons).sort((a, b) => b[1] - a[1]).forEach(([r, c]) => {
    console.log(`    ${r.padEnd(42)} ${c}`);
  });
}

await p.$disconnect();
console.log('\n✓ Analysis complete');
