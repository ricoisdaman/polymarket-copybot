/**
 * Overnight run analysis — focuses on the last ~12 hours of activity
 */
import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();

// Overnight window: last 12 hours
const since12h = new Date(Date.now() - 12 * 60 * 60 * 1000);
// Previous 24h for comparison
const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
// Since last restart (approximate: when config was last synced)
const since48h = new Date(Date.now() - 48 * 60 * 60 * 1000);

function fmt(n) { return (n >= 0 ? '+' : '') + Number(n).toFixed(4); }
function pct(a, b) { return b === 0 ? 'n/a' : ((a / b) * 100).toFixed(1) + '%'; }
function sep(label) {
  console.log('\n' + '═'.repeat(72));
  console.log('  ' + label);
  console.log('═'.repeat(72));
}

// ─── 1. Current runtime state ─────────────────────────────────────────────────
sep('1. CURRENT RUNTIME STATE');
for (const pid of ['live','paper-v2','paper-v3']) {
  const metrics = await p.runtimeMetric.findMany({ where: { profileId: pid } });
  const m = Object.fromEntries(metrics.map(r => [r.key, r.value]));
  const heartbeatAge = m['bot.heartbeat_ts']
    ? Math.round((Date.now() - new Date(m['bot.heartbeat_ts']).getTime()) / 1000)
    : null;
  const hbStr = heartbeatAge === null ? 'no heartbeat'
    : heartbeatAge < 60 ? `${heartbeatAge}s ago (LIVE)`
    : heartbeatAge < 300 ? `${Math.round(heartbeatAge/60)}m ago (STALE?)`
    : `${Math.round(heartbeatAge/60)}m ago (OFFLINE)`;
  console.log(`  ${pid.padEnd(18)} cash=$${Number(m['bot.cash_usdc']??0).toFixed(2)}  dailyNotional=$${Number(m['bot.daily_notional_usdc']??0).toFixed(2)}  drawdown=${m['bot.drawdown_usdc'] !== undefined ? fmt(Number(m['bot.drawdown_usdc'])) : 'n/a'}  heartbeat=${hbStr}`);
}

// ─── 2. Active config (did syncActiveConfigVersion pick up changes?) ──────────
sep('2. ACTIVE CONFIG — confirming new settings took effect');
for (const pid of ['live','paper-v2','paper-v3']) {
  const cv = await p.configVersion.findFirst({ where: { profileId: pid, active: true }, orderBy: { createdAt: 'desc' } });
  if (!cv) { console.log(`  ${pid}: no active config`); continue; }
  let cfg; try { cfg = JSON.parse(cv.json); } catch { continue; }
  const b = cfg.budget ?? {}, f = cfg.filters ?? {};
  console.log(`  ${pid.padEnd(18)} minP=${f.minPrice}  maxP=${f.maxPrice}  daily=$${b.maxDailyNotionalUSDC}  drawdownCap=$${b.maxDailyDrawdownUSDC}  updatedAt=${cv.createdAt.toLocaleString()}`);
}

// ─── 3. Overnight fills & P&L ─────────────────────────────────────────────────
sep('3. OVERNIGHT FILLS (last 12h) — per profile');
for (const pid of ['live','paper-v2','paper-v3']) {
  const orders = await p.order.findMany({
    where: { profileId: pid, ts: { gte: since12h } },
    select: { id: true, intentId: true, side: true, ts: true }
  });
  const orderMap = new Map(orders.map(o => [o.id, o]));
  const intentIds = [...new Set(orders.map(o => o.intentId))];
  const intents = intentIds.length ? await p.copyIntent.findMany({
    where: { id: { in: intentIds } }, select: { id: true, tokenId: true }
  }) : [];
  const intentMap = new Map(intents.map(i => [i.id, i]));

  const fills = await p.fill.findMany({ where: { profileId: pid, ts: { gte: since12h } } });

  let buyNotional = 0, sellNotional = 0, buyCount = 0, sellCount = 0;
  const tokenPnl = new Map();
  for (const fill of fills) {
    const order = orderMap.get(fill.orderId);
    const intent = order ? intentMap.get(order.intentId) : null;
    const tokenId = intent?.tokenId ?? 'unknown';
    const side = order?.side ?? 'BUY';
    const notional = fill.price * fill.size;
    if (!tokenPnl.has(tokenId)) tokenPnl.set(tokenId, { cost: 0, proceeds: 0, buys: 0, sells: 0 });
    const t = tokenPnl.get(tokenId);
    if (side === 'BUY') { buyNotional += notional; buyCount++; t.cost += notional; t.buys++; }
    else { sellNotional += notional; sellCount++; t.proceeds += notional; t.sells++; }
  }
  let realizedPnl = 0, wins = 0, losses = 0;
  for (const [, t] of tokenPnl) {
    if (t.sells > 0 && t.buys > 0) {
      const pnl = t.proceeds - t.cost;
      realizedPnl += pnl; if (pnl >= 0) wins++; else losses++;
    }
  }
  console.log(`  ${pid.padEnd(18)} buys=${buyCount}  sells=${sellCount}  deployed=$${buyNotional.toFixed(2)}  returned=$${sellNotional.toFixed(2)}  closed=${wins+losses}  wins=${wins}  losses=${losses}  PnL=${fmt(realizedPnl)}`);
}

// ─── 4. The 4 losing trades — what were they? ────────────────────────────────
sep('4. LOSING TRADES overnight (last 12h) — live profile detail');
const liveOrders12h = await p.order.findMany({
  where: { profileId: 'live', ts: { gte: since12h } },
  select: { id: true, intentId: true, side: true }
});
const liveOrderMap12h = new Map(liveOrders12h.map(o => [o.id, o]));
const liveIntentMap12h = new Map(
  (await p.copyIntent.findMany({ where: { profileId: 'live', ts: { gte: since12h } }, select: { id: true, tokenId: true } }))
  .map(i => [i.id, i])
);
const liveFills12h = await p.fill.findMany({ where: { profileId: 'live', ts: { gte: since12h } } });
const tokenCF12h = new Map();
for (const fill of liveFills12h) {
  const order = liveOrderMap12h.get(fill.orderId);
  const intent = order ? liveIntentMap12h.get(order.intentId) : null;
  const tokenId = intent?.tokenId; if (!tokenId) continue;
  if (!tokenCF12h.has(tokenId)) tokenCF12h.set(tokenId, { cost: 0, proceeds: 0, side: null });
  const cf = tokenCF12h.get(tokenId);
  if (order.side === 'BUY') cf.cost += fill.price * fill.size;
  else { cf.proceeds += fill.price * fill.size; cf.side = 'closed'; }
}
// Get titles and leader entry price
const allTids = [...tokenCF12h.keys()];
const titleEvs = await p.leaderEvent.findMany({
  where: { tokenId: { in: allTids } },
  select: { tokenId: true, rawJson: true, price: true, side: true },
  distinct: ['tokenId']
});
const titleMap = new Map();
for (const ev of titleEvs) {
  try { titleMap.set(ev.tokenId, { title: (JSON.parse(ev.rawJson)?.title ?? '').substring(0,45), leaderPrice: ev.price }); } catch {}
}

const closedTrades = [...tokenCF12h.entries()]
  .filter(([, cf]) => cf.proceeds > 0)
  .map(([tid, cf]) => ({
    pnl: cf.proceeds - cf.cost,
    cost: cf.cost,
    proceeds: cf.proceeds,
    title: titleMap.get(tid)?.title ?? tid.slice(0,20),
    leaderPrice: titleMap.get(tid)?.leaderPrice,
  }))
  .sort((a, b) => a.pnl - b.pnl);

if (!closedTrades.length) {
  console.log('  No closed trades in the last 12h (positions still open or settled manually)');
} else {
  for (const t of closedTrades) {
    const entryStr = t.leaderPrice ? ` (leader entered @ ${t.leaderPrice.toFixed(2)})` : '';
    console.log(`  ${fmt(t.pnl).padStart(10)}  invested=$${t.cost.toFixed(2)}  got=$${t.proceeds.toFixed(2)}${entryStr}  "${t.title}"`);
  }
}

// ─── 5. Open positions right now ──────────────────────────────────────────────
sep('5. CURRENT OPEN POSITIONS — live');
const livePositions = await p.position.findMany({ where: { profileId: 'live', size: { gt: 0.001 } } });
if (!livePositions.length) {
  console.log('  No open positions');
} else {
  const posTokenIds = livePositions.map(p => p.tokenId);
  const posEvs = await p.leaderEvent.findMany({
    where: { tokenId: { in: posTokenIds } },
    select: { tokenId: true, rawJson: true, price: true, ts: true },
    distinct: ['tokenId']
  });
  const posTitleMap = new Map();
  for (const ev of posEvs) {
    try {
      const raw = JSON.parse(ev.rawJson);
      posTitleMap.set(ev.tokenId, { title: (raw.title ?? raw.question ?? '').substring(0,45), leaderPrice: ev.price, ts: ev.ts });
    } catch {}
  }
  let totalExposure = 0;
  for (const pos of livePositions) {
    const notional = pos.size * pos.avgPrice;
    totalExposure += notional;
    const info = posTitleMap.get(pos.tokenId);
    const ageHours = info?.ts ? ((Date.now() - new Date(info.ts).getTime()) / 3600000).toFixed(0) : '?';
    console.log(`  avgCost=${pos.avgPrice.toFixed(4)}  notional=$${notional.toFixed(2)}  age=${ageHours}h  "${info?.title ?? pos.tokenId.slice(0,20)}"`);
  }
  console.log(`  TOTAL DEPLOYED: $${totalExposure.toFixed(2)}`);
}

// ─── 6. Skip reasons overnight — are we still missing good trades? ────────────
sep('6. SKIP REASONS overnight (last 12h) — live');
const skips12h = await p.copyIntent.findMany({
  where: { profileId: 'live', status: 'SKIPPED', ts: { gte: since12h } }
});
const skipR = {};
skips12h.forEach(s => { const r = s.reason ?? 'UNKNOWN'; skipR[r] = (skipR[r] ?? 0) + 1; });
const liveIntents12h = await p.copyIntent.findMany({
  where: { profileId: 'live', ts: { gte: since12h } }
});
const filled12h = liveIntents12h.filter(i => i.status === 'FILLED').length;
console.log(`  Filled: ${filled12h}    Skipped: ${skips12h.length}`);
Object.entries(skipR).sort((a, b) => b[1] - a[1]).forEach(([r, c]) => {
  console.log(`    ${r.padEnd(42)} ${c}`);
});

// ─── 7. paper-v2 wider filter — is it picking up more 60-70c trades? ─────────
sep('7. PAPER-V2 overnight — new 60-88c filter capturing extra trades?');
const v2Intents12h = await p.copyIntent.findMany({
  where: { profileId: 'paper-v2', status: 'FILLED', ts: { gte: since12h } }
});
const v2LeaderEvIds = v2Intents12h.map(i => i.leaderEventId);
const v2Evs = v2LeaderEvIds.length ? await p.leaderEvent.findMany({
  where: { profileId: 'paper-v2', id: { in: v2LeaderEvIds } },
  select: { id: true, price: true }
}) : [];
const v2EvMap = new Map(v2Evs.map(e => [e.id, e.price]));

const pBounds = [0, 0.5, 0.6, 0.7, 0.75, 0.8, 0.9, 1.01];
const pLabels = ['<50c','50-60c','60-70c','70-75c','75-80c','80-88c','>88c'];
const v2Bkt = Array(7).fill(0);
for (const intent of v2Intents12h) {
  const price = v2EvMap.get(intent.leaderEventId) ?? 0;
  const i = pBounds.findIndex((b, ix) => price >= b && price < pBounds[ix + 1]);
  if (i >= 0) v2Bkt[i]++;
}
console.log(`  paper-v2 fills last 12h: ${v2Intents12h.length}`);
console.log('  Price distribution:');
pLabels.forEach((l, i) => { if (v2Bkt[i] > 0) console.log(`    ${l.padEnd(10)} ${v2Bkt[i]}`); });

const v2LiveOverlap = v2Intents12h.length > 0
  ? `(live also filled ${filled12h} in same window, overlap needs dedupeKey check)`
  : '';
console.log(`  ${v2LiveOverlap}`);

// ─── 8. Leader activity overnight — how many trades did they make? ────────────
sep('8. LEADER activity overnight (last 12h)');
const leaderEvs12h = await p.leaderEvent.findMany({
  where: { profileId: 'live', ts: { gte: since12h } }
});
const lBuys = leaderEvs12h.filter(e => e.side === 'BUY');
const lSells = leaderEvs12h.filter(e => e.side === 'SELL');
const lNotional = lBuys.reduce((s, e) => s + e.usdcSize, 0);
const pBounds2 = [0, 0.5, 0.6, 0.7, 0.75, 0.8, 0.9, 1.01];
const lBkt = Array(7).fill(0);
lBuys.forEach(e => {
  const i = pBounds2.findIndex((b, ix) => e.price >= b && e.price < pBounds2[ix + 1]);
  if (i >= 0) lBkt[i]++;
});
console.log(`  Leader: ${lBuys.length} buys  ${lSells.length} sells  notional=$${lNotional.toFixed(2)}`);
console.log('  Leader buy price distribution:');
const lLabels = ['<50c','50-60c','60-70c','70-75c','75-80c','80-90c','>90c'];
lLabels.forEach((l, i) => { if (lBkt[i] > 0) console.log(`    ${l.padEnd(10)} ${lBkt[i]}  (${pct(lBkt[i], lBuys.length)})`); });
console.log(`  Our copy rate: ${filled12h}/${lBuys.length} = ${pct(filled12h, lBuys.length)}`);

await p.$disconnect();
console.log('\n✓ Done');
