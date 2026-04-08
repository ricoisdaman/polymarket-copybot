import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const profileId = process.argv[2] ?? "live";
const hours = Number(process.argv[3] ?? 72);
const since = new Date(Date.now() - hours * 60 * 60 * 1000);

function safeJson(s) {
  try { return JSON.parse(s); } catch { return null; }
}

function section(title) {
  console.log(`\n=== ${title} ===`);
}

function dayKey(ts) {
  return new Date(ts).toISOString().slice(0, 10);
}

console.log(`Profile: ${profileId}`);
console.log(`Window : last ${hours}h (since ${since.toISOString()})`);

const cfgRows = await prisma.$queryRawUnsafe(
  `SELECT id, createdAt, json
   FROM ConfigVersion
   WHERE profileId = ? AND active = 1
   ORDER BY createdAt DESC
   LIMIT 1`,
  profileId
);

if (cfgRows.length) {
  const cfg = safeJson(cfgRows[0].json) ?? {};
  section("ACTIVE CONFIG");
  console.log(`mode=${cfg.mode}`);
  console.log(`leader=${cfg?.leader?.wallet ?? "?"}`);
  console.log(`perTrade=${cfg?.budget?.perTradeNotionalUSDC ?? "?"}, maxPerMarket=${cfg?.budget?.maxNotionalPerMarketUSDC ?? "?"}, dailyMax=${cfg?.budget?.maxDailyNotionalUSDC ?? "?"}`);
  console.log(`priceBand=[${cfg?.filters?.minPrice ?? "?"}, ${cfg?.filters?.maxPrice ?? "?"}]`);
}

const leaderEventsAll = await prisma.$queryRawUnsafe(
  `SELECT id, ts, side, tokenId, price, rawJson
   FROM LeaderEvent
   WHERE profileId = ?
   ORDER BY ts ASC`,
  profileId
);

const intentsAll = await prisma.$queryRawUnsafe(
  `SELECT ci.id, ci.ts, ci.status, ci.reason, ci.side, ci.tokenId, ci.desiredNotional,
          ci.desiredSize, ci.leaderEventId, le.price AS leaderPrice, le.rawJson
   FROM CopyIntent ci
   LEFT JOIN LeaderEvent le ON le.id = ci.leaderEventId
   WHERE ci.profileId = ?
   ORDER BY ci.ts ASC`,
  profileId
);

const fillsAll = await prisma.$queryRawUnsafe(
  `SELECT f.id, f.ts, f.price, f.size, f.fee, o.side AS orderSide, o.intentId,
          ci.tokenId, ci.leaderEventId, le.price AS leaderPrice, le.rawJson
   FROM Fill f
   JOIN "Order" o ON o.id = f.orderId
   LEFT JOIN CopyIntent ci ON ci.id = o.intentId
   LEFT JOIN LeaderEvent le ON le.id = ci.leaderEventId
   WHERE f.profileId = ?
   ORDER BY f.ts ASC`,
  profileId
);

function isInWindow(ts) {
  const d = new Date(ts);
  return Number.isFinite(d.getTime()) && d >= since;
}

const leaderEvents = leaderEventsAll.filter((r) => isInWindow(r.ts));
const intents = intentsAll.filter((r) => isInWindow(r.ts));
const fills = fillsAll.filter((r) => isInWindow(r.ts));

section("PIPELINE COUNTS");
if (leaderEventsAll.length) {
  console.log(`leader ts range: ${new Date(leaderEventsAll[0].ts).toISOString()} -> ${new Date(leaderEventsAll[leaderEventsAll.length - 1].ts).toISOString()}`);
}
if (intentsAll.length) {
  console.log(`intent ts range: ${new Date(intentsAll[0].ts).toISOString()} -> ${new Date(intentsAll[intentsAll.length - 1].ts).toISOString()}`);
}
if (fillsAll.length) {
  console.log(`fill ts range  : ${new Date(fillsAll[0].ts).toISOString()} -> ${new Date(fillsAll[fillsAll.length - 1].ts).toISOString()}`);
}
console.log(`leader events: ${leaderEvents.length}`);
console.log(`copy intents : ${intents.length}`);
console.log(`fills        : ${fills.length}`);

const statusCounts = new Map();
const reasonCounts = new Map();
for (const i of intents) {
  statusCounts.set(i.status, (statusCounts.get(i.status) ?? 0) + 1);
  if (i.reason) reasonCounts.set(i.reason, (reasonCounts.get(i.reason) ?? 0) + 1);
}

section("INTENT STATUS BREAKDOWN");
for (const [k, v] of [...statusCounts.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`${String(k).padEnd(12)} ${v}`);
}

section("TOP SKIP/FAIL REASONS");
for (const [k, v] of [...reasonCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
  console.log(`${String(v).padStart(4)}  ${k}`);
}

const filterReasonRegex = /(PRICE_OUTSIDE_FILTER|BLOCKED_TITLE|LOW_LIQUIDITY|FEE_ENABLED|MIN_ORDER|MAX_NOTIONAL|DAILY_NOTIONAL|SPREAD|SLIPPAGE)/i;
const filterGated = intents.filter((i) => i.reason && filterReasonRegex.test(i.reason)).length;
console.log(`\nfilter/risk-gate related skips/fails: ${filterGated}`);

const daily = new Map();
for (const f of fills) {
  const d = dayKey(f.ts);
  const cur = daily.get(d) ?? { fills: 0, buyCost: 0, sellProceeds: 0, fees: 0, netCash: 0 };
  const gross = Number(f.price) * Number(f.size);
  const fee = Number(f.fee ?? 0);
  if (f.orderSide === "BUY") {
    cur.buyCost += gross;
    cur.netCash -= (gross + fee);
  } else {
    cur.sellProceeds += gross;
    cur.netCash += (gross - fee);
  }
  cur.fees += fee;
  cur.fills += 1;
  daily.set(d, cur);
}

section("DAILY CASHFLOW FROM FILLS");
for (const [d, a] of [...daily.entries()].sort((x, y) => x[0].localeCompare(y[0]))) {
  console.log(`${d}  fills=${a.fills}  buy=${a.buyCost.toFixed(2)}  sell=${a.sellProceeds.toFixed(2)}  fees=${a.fees.toFixed(2)}  netCash=${a.netCash.toFixed(2)}`);
}

const tokenAgg = new Map();
for (const f of fills) {
  const tokenId = f.tokenId ?? "UNKNOWN";
  const row = tokenAgg.get(tokenId) ?? {
    tokenId,
    title: tokenId,
    buys: 0,
    sells: 0,
    buyNotional: 0,
    sellNotional: 0,
    fees: 0,
    netShares: 0,
    netCash: 0
  };
  const gross = Number(f.price) * Number(f.size);
  const fee = Number(f.fee ?? 0);
  const raw = safeJson(f.rawJson);
  if (raw?.title && typeof raw.title === "string") row.title = raw.title;

  if (f.orderSide === "BUY") {
    row.buys += 1;
    row.buyNotional += gross;
    row.netShares += Number(f.size);
    row.netCash -= (gross + fee);
  } else {
    row.sells += 1;
    row.sellNotional += gross;
    row.netShares -= Number(f.size);
    row.netCash += (gross - fee);
  }
  row.fees += fee;
  tokenAgg.set(tokenId, row);
}

const tokens = [...tokenAgg.values()];
const closed = tokens.filter((t) => Math.abs(t.netShares) < 1e-6);
const open = tokens.filter((t) => Math.abs(t.netShares) >= 1e-6);

const worstClosed = [...closed].sort((a, b) => a.netCash - b.netCash).slice(0, 8);
const bestClosed = [...closed].sort((a, b) => b.netCash - a.netCash).slice(0, 8);

section("WORST CLOSED TOKENS (REALIZED)");
if (worstClosed.length === 0) console.log("none");
for (const t of worstClosed) {
  console.log(`${t.netCash.toFixed(2).padStart(8)}  ${t.title.slice(0, 90)}`);
}

section("BEST CLOSED TOKENS (REALIZED)");
if (bestClosed.length === 0) console.log("none");
for (const t of bestClosed) {
  console.log(`${t.netCash.toFixed(2).padStart(8)}  ${t.title.slice(0, 90)}`);
}

const realized = closed.reduce((s, t) => s + t.netCash, 0);
const openCostBasis = open.reduce((s, t) => s + Math.max(0, -t.netCash), 0);

section("PNL SNAPSHOT");
console.log(`closed tokens: ${closed.length}`);
console.log(`open tokens  : ${open.length}`);
console.log(`realized pnl from closed tokens: ${realized.toFixed(2)}`);
console.log(`open risk cost-basis proxy     : ${openCostBasis.toFixed(2)}`);

const slippages = [];
for (const f of fills) {
  const lp = Number(f.leaderPrice);
  const fp = Number(f.price);
  if (!Number.isFinite(lp) || lp <= 0 || !Number.isFinite(fp)) continue;
  let bps = 0;
  if (f.orderSide === "BUY") {
    bps = ((fp - lp) / lp) * 10000;
  } else {
    bps = ((lp - fp) / lp) * 10000;
  }
  slippages.push(bps);
}

if (slippages.length > 0) {
  const sorted = [...slippages].sort((a, b) => a - b);
  const avg = slippages.reduce((a, b) => a + b, 0) / slippages.length;
  const p50 = sorted[Math.floor(sorted.length * 0.5)];
  const p90 = sorted[Math.floor(sorted.length * 0.9)];
  const p10 = sorted[Math.floor(sorted.length * 0.1)];
  section("EXECUTION VS LEADER PRICE (BPS)");
  console.log(`samples=${slippages.length}, avg=${avg.toFixed(1)}, p10=${p10.toFixed(1)}, p50=${p50.toFixed(1)}, p90=${p90.toFixed(1)}`);
  console.log(`positive means worse execution than leader`);
}

section("OPEN POSITION DRIFT CHECK");
const openPositions = await prisma.$queryRawUnsafe(
  `SELECT tokenId, size, avgPrice, updatedAt
   FROM Position
   WHERE profileId = ? AND size > 0
   ORDER BY updatedAt DESC`,
  profileId
);
console.log(`open DB positions: ${openPositions.length}`);
for (const p of openPositions.slice(0, 10)) {
  console.log(`${String(p.size).padStart(12)} @ ${Number(p.avgPrice).toFixed(4)}  token=${String(p.tokenId).slice(0, 22)}... updated=${new Date(p.updatedAt).toISOString()}`);
}

section("RECENT LIVE EXECUTION ERRORS");
const errs = await prisma.$queryRawUnsafe(
  `SELECT ts, code, message, contextJson
   FROM Alert
   WHERE profileId = ? AND code = 'LIVE_EXECUTION_ERROR'
   ORDER BY ts DESC
   LIMIT 20`,
  profileId
);
const errsInWindow = errs.filter((e) => isInWindow(e.ts));
if (errsInWindow.length === 0) {
  console.log("none in window");
} else {
  for (const e of errsInWindow) {
    const ctx = safeJson(e.contextJson) ?? {};
    const msg = String(ctx.error ?? e.message ?? "").slice(0, 160);
    console.log(`${new Date(e.ts).toISOString()}  ${msg}`);
  }
}

await prisma.$disconnect();
