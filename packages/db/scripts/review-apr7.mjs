/**
 * Overnight review — April 7 2026
 * Covers: all profiles' fills, P&L, pause events, winners/losers, v2 vs live comparison
 */
import { PrismaClient } from '@prisma/client';
const dbPath = 'C:/Users/Rico/new-bot-GPT/packages/db/prisma/dev.db';
const p = new PrismaClient({ datasources: { db: { url: `file:${dbPath}` } } });

function sep(label) {
  console.log('\n' + '═'.repeat(76));
  console.log('  ' + label);
  console.log('═'.repeat(76));
}
function fmt(n) { return (n >= 0 ? '+' : '') + Number(n).toFixed(4); }
function pct(a, b) { return b === 0 ? 'n/a' : (a / b * 100).toFixed(1) + '%'; }

const now = Date.now();
const h16  = new Date(now - 16 * 60 * 60 * 1000);
const h24  = new Date(now - 24 * 60 * 60 * 1000);
const h72  = new Date(now - 72 * 60 * 60 * 1000);
const allProfiles = ['live', 'paper-v2', 'paper-v3'];

// ── 1. Current runtime state ──────────────────────────────────────────────────
sep('1. CURRENT RUNTIME STATE');
for (const pid of [...allProfiles, 'paper-sports-b']) {
  const metrics = await p.runtimeMetric.findMany({ where: { profileId: pid } });
  const m = Object.fromEntries(metrics.map(r => [r.key, r.value]));
  const hbAge = m['bot.heartbeat_ts'] ? Math.round((now - Number(m['bot.heartbeat_ts'])) / 1000) : null;
  const hbStr = hbAge === null ? 'OFFLINE' : hbAge < 120 ? `${hbAge}s (LIVE)` : `${Math.round(hbAge/60)}m ago (OFFLINE)`;
  const cash = m['bot.cash_usdc'] ? `$${Number(m['bot.cash_usdc']).toFixed(2)}` : 'n/a';
  const drawdown = m['bot.drawdown_usdc'] ? fmt(Number(m['bot.drawdown_usdc'])) : 'n/a';
  const cfg = await p.configVersion.findFirst({ where: { profileId: pid, active: true }, orderBy: { createdAt: 'desc' } });
  const rt = cfg ? JSON.parse(cfg.json)?.runtime ?? {} : {};
  console.log(`  ${pid.padEnd(14)} cash=${cash}  drawdown=${drawdown}  hb=${hbStr}  paused=${rt.paused ?? 'false'}  kill=${rt.killSwitch ?? 'false'}`);
}

// ── 2. Fills last 16h — per profile with win/loss ────────────────────────────
sep('2. FILLS — last 16h (overnight)');
for (const pid of allProfiles) {
  const fills = await p.fill.findMany({
    where: { profileId: pid, ts: { gt: h16 } },
    orderBy: { ts: 'asc' },
    select: { ts: true, price: true, size: true, orderId: true }
  });
  if (fills.length === 0) { console.log(`  ${pid}: no fills`); continue; }

  // Link fills to orders to get intent context
  const deployed = fills.reduce((s, f) => s + Number(f.price) * Number(f.size), 0);
  console.log(`\n  ${pid}: ${fills.length} fills  deployed=$${deployed.toFixed(2)}`);
  for (const f of fills) {
    const t = new Date(f.ts).toLocaleTimeString('en-GB');
    console.log(`    ${t}  price=${Number(f.price).toFixed(3)}  size=${Number(f.size).toFixed(3)}  cost=$${(Number(f.price)*Number(f.size)).toFixed(2)}`);
  }
}

// ── 3. Closed positions / realized P&L last 16h ──────────────────────────────
sep('3. POSITIONS CLOSED (resolved/settled) — last 16h');
for (const pid of allProfiles) {
  // Find POSITIONS_SYNCED alerts = market resolved, position zeroed
  const synced = await p.alert.findMany({
    where: { profileId: pid, ts: { gt: h16 }, code: 'POSITIONS_SYNCED' },
    orderBy: { ts: 'desc' },
    select: { ts: true, message: true, contextJson: true }
  });
  if (synced.length === 0) { console.log(`  ${pid}: no closed positions`); continue; }
  console.log(`\n  ${pid}: ${synced.length} position(s) resolved`);
  synced.forEach(a => {
    let ctx = {};
    try { ctx = JSON.parse(a.contextJson); } catch {}
    const t = new Date(a.ts).toLocaleTimeString('en-GB');
    console.log(`    ${t}  ${a.message.substring(0,80)}`);
    if (ctx.zeroed) console.log(`          zeroed positions: ${JSON.stringify(ctx.zeroed)}`);
  });
}

// ── 4. All alerts last 16h (all profiles) ────────────────────────────────────
sep('4. ALL ALERTS — last 16h (all profiles)');
const alerts16h = await p.alert.findMany({
  where: { ts: { gt: h16 } },
  orderBy: { ts: 'desc' },
  take: 60
});
alerts16h.forEach(a => {
  const t = new Date(a.ts).toLocaleString('en-GB');
  console.log(`  ${t}  ${(a.profileId ?? '').padEnd(14)} [${a.severity}] ${a.code}: ${a.message.substring(0, 70)}`);
});

// ── 5. Pause events — WHY was the bot paused? ───────────────────────────────
sep('5. PAUSE ANALYSIS — last 72h (all profiles)');
for (const pid of [...allProfiles, 'paper-sports-b']) {
  const pauseSkips = await p.copyIntent.groupBy({
    by: ['reason'],
    where: { profileId: pid, status: 'SKIPPED', reason: { in: ['PAUSED', 'DRAWDOWN_STOP', 'KILL_SWITCH'] }, ts: { gt: h72 } },
    _count: true
  });
  const total = pauseSkips.reduce((s, x) => s + x._count, 0);
  if (total === 0) { continue; }
  const breakdown = pauseSkips.map(s => `${s.reason}=${s._count}`).join('  ');
  console.log(`  ${pid.padEnd(14)} total=${total}  ${breakdown}`);
}

// Pause-triggering alerts (config changes, guardian pauses)
console.log('\n  Pause-triggering alerts (RUNTIME_CONTROL_UPDATED, INTENT_STUCK, BOT_HEARTBEAT_STALE, DRAWDOWN_STOP):');
const pauseAlerts = await p.alert.findMany({
  where: {
    ts: { gt: h72 },
    code: { in: ['RUNTIME_CONTROL_UPDATED', 'INTENT_STUCK', 'BOT_HEARTBEAT_STALE', 'DAILY_DRAWDOWN_STOP', 'ERROR_STORM'] }
  },
  orderBy: { ts: 'desc' },
  take: 40
});
if (pauseAlerts.length === 0) console.log('    (none)');
pauseAlerts.forEach(a => {
  const t = new Date(a.ts).toLocaleString('en-GB');
  let ctx = {};
  try { ctx = JSON.parse(a.contextJson); } catch {}
  const extra = ctx.reason ? ` [${ctx.reason}]` : '';
  console.log(`  ${t}  ${(a.profileId ?? '').padEnd(14)} [${a.severity}] ${a.code}${extra}: ${a.message.substring(0, 60)}`);
});

// Config version history (shows when paused was set/cleared)
console.log('\n  Config changes (last 72h):');
const cfgChanges = await p.configVersion.findMany({
  where: { createdAt: { gt: h72 } },
  orderBy: { createdAt: 'desc' },
  take: 30,
  select: { profileId: true, createdAt: true, active: true, json: true }
});
cfgChanges.forEach(c => {
  const rt = JSON.parse(c.json)?.runtime ?? {};
  const t = new Date(c.createdAt).toLocaleString('en-GB');
  if (rt.paused !== undefined || rt.killSwitch !== undefined) {
    console.log(`  ${t}  ${c.profileId.padEnd(14)} active=${c.active}  paused=${rt.paused}  kill=${rt.killSwitch}`);
  }
});

// ── 6. Skip reasons last 16h per profile ─────────────────────────────────────
sep('6. SKIP REASONS — last 16h');
for (const pid of allProfiles) {
  const skips = await p.copyIntent.groupBy({
    by: ['reason'],
    where: { profileId: pid, status: 'SKIPPED', ts: { gt: h16 } },
    _count: true
  });
  const total = skips.reduce((s, x) => s + x._count, 0);
  if (total === 0) { console.log(`  ${pid}: no skips`); continue; }
  const top = skips.sort((a, b) => b._count - a._count).map(s => `${s.reason}=${s._count}`).join('  ');
  console.log(`  ${pid.padEnd(14)} ${top}`);
}

// ── 7. v2 vs live deep comparison ────────────────────────────────────────────
sep('7. v2 vs LIVE — fill quality comparison (last 72h)');
for (const pid of ['live', 'paper-v2']) {
  const fills = await p.fill.findMany({
    where: { profileId: pid, ts: { gt: h72 } },
    select: { price: true, size: true, ts: true }
  });
  if (fills.length === 0) { console.log(`  ${pid}: no fills`); continue; }

  const prices = fills.map(f => Number(f.price));
  const avg = prices.reduce((s, p) => s + p, 0) / prices.length;
  const min = Math.min(...prices);
  const max = Math.max(...prices);

  // Bucket breakdown
  const b = { '60-70c': 0, '70-75c': 0, '75-80c': 0, '80-88c': 0, 'other': 0 };
  prices.forEach(pr => {
    if (pr >= 0.60 && pr < 0.70) b['60-70c']++;
    else if (pr >= 0.70 && pr < 0.75) b['70-75c']++;
    else if (pr >= 0.75 && pr < 0.80) b['75-80c']++;
    else if (pr >= 0.80 && pr <= 0.88) b['80-88c']++;
    else b['other']++;
  });

  const costBasis = await p.position.findMany({ where: { profileId: pid, size: { gt: 0 } } });
  const openCost = costBasis.reduce((s, pos) => s + Number(pos.size) * Number(pos.avgPrice), 0);
  const cashMetric = await p.runtimeMetric.findFirst({ where: { profileId: pid, key: 'bot.cash_usdc' } });
  const startMetric = await p.runtimeMetric.findFirst({ where: { profileId: pid, key: 'bot.live_starting_usdc' } });
  const cash = cashMetric ? Number(cashMetric.value) : null;
  const starting = startMetric ? Number(startMetric.value) : null;
  const equity = cash !== null ? cash + openCost : null;
  const pnl = equity !== null && starting !== null ? equity - starting : null;

  console.log(`\n  ${pid}: ${fills.length} fills (72h)  avgPrice=${avg.toFixed(3)}  range=${min.toFixed(3)}-${max.toFixed(3)}`);
  console.log(`    Buckets: 60-70c=${b['60-70c']}  70-75c=${b['70-75c']}  75-80c=${b['75-80c']}  80-88c=${b['80-88c']}  other=${b['other']}`);
  if (pnl !== null) console.log(`    AllTime PnL: ${fmt(pnl)}  (cash=$${cash?.toFixed(2)}  openCost=$${openCost.toFixed(2)}  starting=$${starting})`);
}

// ── 8. Leader activity overnight ─────────────────────────────────────────────
sep('8. LEADER ACTIVITY — last 16h');
const leaderBuys = await p.leaderEvent.count({ where: { profileId: 'live', side: 'BUY', ts: { gt: h16 } } });
const leaderPrices = await p.leaderEvent.findMany({
  where: { profileId: 'live', side: 'BUY', ts: { gt: h16 } },
  select: { price: true }
});
const lp = leaderPrices.map(e => Number(e.price));
if (lp.length > 0) {
  const buckets = { '<50c': 0, '50-60c': 0, '60-70c': 0, '70-80c': 0, '80-88c': 0, '>88c': 0 };
  lp.forEach(pr => {
    if (pr < 0.50) buckets['<50c']++;
    else if (pr < 0.60) buckets['50-60c']++;
    else if (pr < 0.70) buckets['60-70c']++;
    else if (pr < 0.80) buckets['70-80c']++;
    else if (pr < 0.88) buckets['80-88c']++;
    else buckets['>88c']++;
  });
  const liveFilled = await p.copyIntent.count({ where: { profileId: 'live', status: 'FILLED', ts: { gt: h16 } } });
  const v2Filled   = await p.copyIntent.count({ where: { profileId: 'paper-v2', status: 'FILLED', ts: { gt: h16 } } });
  const v3Filled   = await p.copyIntent.count({ where: { profileId: 'paper-v3', status: 'FILLED', ts: { gt: h16 } } });
  console.log(`  Leader buys: ${leaderBuys}  Price dist: ${Object.entries(buckets).map(([k,v])=>`${k}:${v}`).join('  ')}`);
  console.log(`  live copied: ${liveFilled}/${leaderBuys} (${pct(liveFilled, leaderBuys)})`);
  console.log(`  v2 copied:   ${v2Filled}/${leaderBuys} (${pct(v2Filled, leaderBuys)})`);
  console.log(`  v3 copied:   ${v3Filled}/${leaderBuys} (${pct(v3Filled, leaderBuys)})`);
}

await p.$disconnect();
console.log('\n✔ Done');
