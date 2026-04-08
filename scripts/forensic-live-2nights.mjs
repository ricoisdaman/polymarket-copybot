import Database from "better-sqlite3";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = resolve(__dirname, "../packages/db/prisma/dev.db");
const db = new Database(dbPath, { readonly: true });

const profileId = process.argv[2] ?? "live";
const hours = Number(process.argv[3] ?? 72);
const sinceIso = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

function safeJson(s) {
  try { return JSON.parse(s); } catch { return null; }
}

function logSection(title) {
  console.log(`\n=== ${title} ===`);
}

console.log(`Profile: ${profileId}`);
console.log(`Window : last ${hours}h (since ${sinceIso})`);

const cfgRow = db.prepare(`
  SELECT json, createdAt
  FROM ConfigVersion
  WHERE profileId = ? AND active = 1
  ORDER BY createdAt DESC
  LIMIT 1
`).get(profileId);

if (cfgRow) {
  const cfg = safeJson(cfgRow.json) ?? {};
  logSection("ACTIVE CONFIG SNAPSHOT");
  console.log(`mode=${cfg.mode}`);
  console.log(`leader=${cfg?.leader?.wallet ?? "?"}`);
  console.log(`perTrade=${cfg?.budget?.perTradeNotionalUSDC ?? "?"}, maxPerMarket=${cfg?.budget?.maxNotionalPerMarketUSDC ?? "?"}, dailyMax=${cfg?.budget?.maxDailyNotionalUSDC ?? "?"}`);
  console.log(`priceBand=[${cfg?.filters?.minPrice ?? "?"}, ${cfg?.filters?.maxPrice ?? "?"}]`);
}

const intents = db.prepare(`
  SELECT ci.id, ci.ts, ci.status, ci.reason, ci.side, ci.tokenId, ci.desiredNotional,
         le.price AS leaderPrice, le.rawJson
  FROM CopyIntent ci
  LEFT JOIN LeaderEvent le ON le.id = ci.leaderEventId
  WHERE ci.profileId = ? AND ci.ts >= ?
  ORDER BY ci.ts ASC
`).all(profileId, sinceIso);

const leaderEvents = db.prepare(`
  SELECT id, ts, side, tokenId, price, rawJson
  FROM LeaderEvent
  WHERE profileId = ? AND ts >= ?
  ORDER BY ts ASC
`).all(profileId, sinceIso);

const fills = db.prepare(`
  SELECT f.ts, f.price, f.size, f.fee, o.side AS orderSide, o.intentId, ci.tokenId, ci.leaderEventId,
         le.price AS leaderPrice, le.rawJson
  FROM Fill f
  JOIN "Order" o ON o.id = f.orderId
  LEFT JOIN CopyIntent ci ON ci.id = o.intentId
  LEFT JOIN LeaderEvent le ON le.id = ci.leaderEventId
  WHERE f.profileId = ? AND f.ts >= ?
  ORDER BY f.ts ASC
`).all(profileId, sinceIso);

logSection("PIPELINE VOLUME");
console.log(`leader events: ${leaderEvents.length}`);
console.log(`copy intents : ${intents.length}`);
console.log(`fills        : ${fills.length}`);

const statusCounts = new Map();
const reasonCounts = new Map();
for (const it of intents) {
  statusCounts.set(it.status, (statusCounts.get(it.status) ?? 0) + 1);
  if (it.reason) reasonCounts.set(it.reason, (reasonCounts.get(it.reason) ?? 0) + 1);
}

logSection("INTENT STATUS BREAKDOWN");
for (const [k, v] of [...statusCounts.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`${k.padEnd(12)} ${v}`);
}

logSection("TOP SKIP/FAIL REASONS");
for (const [k, v] of [...reasonCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
  console.log(`${String(v).padStart(4)}  ${k}`);
}

const filterReasonRegex = /(PRICE_OUTSIDE_FILTER|BLOCKED_TITLE|LOW_LIQUIDITY|FEE_ENABLED|MIN_ORDER|MAX_NOTIONAL|DAILY_NOTIONAL|SPREAD|SLIPPAGE)/i;
const filterRelated = intents.filter((i) => i.reason && filterReasonRegex.test(i.reason)).length;
console.log(`\nfilter/risk-gate related skipped/failed intents: ${filterRelated}`);

const dayAgg = new Map();
function getDay(ts) {
  return new Date(ts).toISOString().slice(0, 10);
}
for (const f of fills) {
  const d = getDay(f.ts);
  const cur = dayAgg.get(d) ?? { buyCost: 0, sellProceeds: 0, fees: 0, netCash: 0, fills: 0 };
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
  dayAgg.set(d, cur);
}

logSection("DAILY CASHFLOW FROM FILLS (NOT MARK-TO-MARKET)");
for (const [d, a] of [...dayAgg.entries()].sort((x, y) => x[0].localeCompare(y[0]))) {
  console.log(`${d}  fills=${a.fills}  buy=${a.buyCost.toFixed(2)}  sell=${a.sellProceeds.toFixed(2)}  fees=${a.fees.toFixed(2)}  netCash=${a.netCash.toFixed(2)}`);
}

const tokenAgg = new Map();
for (const f of fills) {
  const token = f.tokenId ?? "UNKNOWN";
  const cur = tokenAgg.get(token) ?? { buys: 0, sells: 0, buyNotional: 0, sellNotional: 0, fees: 0, netShares: 0, netCash: 0, title: token };
  const gross = Number(f.price) * Number(f.size);
  const fee = Number(f.fee ?? 0);
  const raw = safeJson(f.rawJson);
  if (raw?.title && typeof raw.title === "string") cur.title = raw.title;

  if (f.orderSide === "BUY") {
    cur.buys += 1;
    cur.buyNotional += gross;
    cur.netShares += Number(f.size);
    cur.netCash -= (gross + fee);
  } else {
    cur.sells += 1;
    cur.sellNotional += gross;
    cur.netShares -= Number(f.size);
    cur.netCash += (gross - fee);
  }
  cur.fees += fee;
  tokenAgg.set(token, cur);
}

const tokenRows = [...tokenAgg.entries()].map(([tokenId, v]) => ({ tokenId, ...v }));
const closed = tokenRows.filter((r) => Math.abs(r.netShares) < 1e-6);
const open = tokenRows.filter((r) => Math.abs(r.netShares) >= 1e-6);

logSection("CLOSED-TOKEN REALIZED PNL (BEST/WORST)");
const closedSorted = closed.sort((a, b) => a.netCash - b.netCash);
for (const r of closedSorted.slice(0, 5)) {
  console.log(`LOSS  ${r.netCash.toFixed(2).padStart(8)}  ${r.title.slice(0, 80)}`);
}
for (const r of closedSorted.slice(-5).reverse()) {
  console.log(`WIN   ${r.netCash.toFixed(2).padStart(8)}  ${r.title.slice(0, 80)}`);
}

const realized = closed.reduce((s, r) => s + r.netCash, 0);
const openRiskCost = open.reduce((s, r) => s + Math.max(0, -r.netCash), 0);
logSection("PNL SUMMARY");
console.log(`closed tokens: ${closed.length}, open tokens: ${open.length}`);
console.log(`realized pnl from fully closed tokens: ${realized.toFixed(2)}`);
console.log(`capital currently at risk in open tokens (cost basis proxy): ${openRiskCost.toFixed(2)}`);

const slips = [];
for (const f of fills) {
  if (!f.leaderPrice || !f.orderSide) continue;
  const lp = Number(f.leaderPrice);
  const fp = Number(f.price);
  if (!Number.isFinite(lp) || lp <= 0 || !Number.isFinite(fp)) continue;
  let bps = 0;
  if (f.orderSide === "BUY") bps = ((fp - lp) / lp) * 10000;
  else bps = ((lp - fp) / lp) * 10000;
  slips.push(bps);
}

if (slips.length > 0) {
  const avg = slips.reduce((a, b) => a + b, 0) / slips.length;
  const sorted = [...slips].sort((a, b) => a - b);
  const p50 = sorted[Math.floor(sorted.length * 0.5)];
  const p90 = sorted[Math.floor(sorted.length * 0.9)];
  logSection("EXECUTION VS LEADER PRICE");
  console.log(`samples=${slips.length}, avgSlippageBps=${avg.toFixed(1)}, p50=${p50.toFixed(1)}, p90=${p90.toFixed(1)}`);
  console.log(`positive bps means worse than leader price.`);
}

logSection("RECENT LOSER FILLS (LAST 15, CONTEXT)");
const recent = fills.slice(-15);
for (const f of recent) {
  const raw = safeJson(f.rawJson);
  const title = (raw?.title ?? f.tokenId ?? "?").toString().slice(0, 72);
  const gross = Number(f.price) * Number(f.size);
  console.log(`${new Date(f.ts).toISOString()} ${String(f.orderSide).padEnd(4)} px=${Number(f.price).toFixed(4)} sz=${Number(f.size).toFixed(4)} usdc=${gross.toFixed(2)} ${title}`);
}

db.close();
