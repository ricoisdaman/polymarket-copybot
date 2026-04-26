// Counterfactual P&L simulation
// Tests proposed filters against actual trade data (live + paper-v2)
// Uses the same exit-price reconstruction as _analysis_live_vs_paper.mjs

import { PrismaClient } from "./packages/db/node_modules/@prisma/client/index.js";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbUrl = "file:" + path.resolve(__dirname, "./packages/db/prisma/dev.db").replace(/\\/g, "/");
const prisma = new PrismaClient({ datasources: { db: { url: dbUrl } } });

function slugSport(slug) {
  if (!slug) return "other";
  if (slug.startsWith("atp-")) return "ATP";
  if (slug.startsWith("wta-")) return "WTA";
  if (slug.startsWith("tennis-")) return "TENNIS";
  if (slug.startsWith("mlb-")) return "MLB";
  if (slug.startsWith("nba-")) return "NBA";
  if (slug.startsWith("nhl-")) return "NHL";
  if (slug.startsWith("cbb-")) return "NCAA_BB";
  return "other";
}

function summarise(trades) {
  const wins = trades.filter(t => t.pnl > 0).length;
  const total = trades.reduce((s, t) => s + t.pnl, 0);
  const winRate = trades.length ? (wins / trades.length * 100).toFixed(1) + "%" : "-";
  return { n: trades.length, wins, winRate, pnl: total };
}

function fmt(n) { return (n >= 0 ? "+" : "") + "$" + n.toFixed(2); }

// ── Load exit price map from paper-v2 ────────────────────────────────────────
const p2Sells = await prisma.$queryRawUnsafe(`
  SELECT ci.tokenId,
    SUM(f.price * f.size) / SUM(f.size) as avgExitPrice
  FROM CopyIntent ci
  JOIN "Order" o ON o.intentId = ci.id
  JOIN Fill f ON f.orderId = o.id
  WHERE ci.profileId = 'paper-v2' AND ci.side = 'SELL' AND o.side = 'SELL'
  GROUP BY ci.tokenId
`);
const exitMap = {};
for (const r of p2Sells) exitMap[r.tokenId] = Number(r.avgExitPrice);

// ── Load all BUY fills for both profiles ──────────────────────────────────────
async function loadBuys(profileId) {
  return prisma.$queryRawUnsafe(`
    SELECT ci.tokenId, ci.id as intentId, ci.ts as intentTs,
      le.rawJson, le.price as leaderPrice, ci.leaderSize as leaderUsdc,
      SUM(f.price * f.size) as fillCost,
      SUM(f.size) as fillShares
    FROM CopyIntent ci
    JOIN LeaderEvent le ON ci.leaderEventId = le.id
    JOIN "Order" o ON o.intentId = ci.id
    JOIN Fill f ON f.orderId = o.id
    WHERE ci.profileId = '${profileId}' AND ci.side = 'BUY' AND o.side = 'BUY'
    GROUP BY ci.id
  `);
}

// ── Build resolved trade records ─────────────────────────────────────────────
async function buildTrades(profileId) {
  const buys = await loadBuys(profileId);
  const openSet = new Set(
    (await prisma.position.findMany({ where: { profileId, size: { gt: 0.01 } } }))
      .map(p => p.tokenId)
  );

  // For paper-v2 use its own exits; for live use paper-v2's exits
  const myExitMap = profileId === "paper-v2"
    ? exitMap
    : exitMap; // live uses same paper-v2 map

  const trades = [];
  for (const row of buys) {
    const tokenId = row.tokenId;
    if (openSet.has(tokenId)) continue;
    const exitPrice = myExitMap[tokenId];
    if (exitPrice === undefined) continue;

    let raw = {};
    try { raw = JSON.parse(row.rawJson); } catch {}
    const slug = (raw.slug ?? raw.eventSlug ?? "").toLowerCase();
    const sport = slugSport(slug);
    const cost = Number(row.fillCost);
    const shares = Number(row.fillShares);
    const pnl = (exitPrice * shares) - cost;
    const intentTs = new Date(row.intentTs);

    trades.push({
      tokenId, slug, sport, pnl, cost, shares,
      leaderPrice: Number(row.leaderPrice),
      leaderUsdc: Number(row.leaderUsdc),
      hourUtc: intentTs.getUTCHours(),
    });
  }
  return trades;
}

const liveTrades = await buildTrades("live");
const p2Trades   = await buildTrades("paper-v2");

// ═══════════════════════════════════════════════════════════════════════════
// SCENARIO DEFINITIONS
// Each scenario is a filter function: returns true = keep the trade
// ═══════════════════════════════════════════════════════════════════════════

const scenarios = {

  // ── BASELINE (current live config, minus the tennis block) ────────────────
  "BASELINE (current)": (t) => true,

  // ────────────────────────────────────────────────────────────────────────
  // TENNIS SCENARIOS
  // ────────────────────────────────────────────────────────────────────────

  // [T1] Current: tennis fully blocked (simulate by removing ATP/WTA)
  "T1: Tennis fully blocked (current live)": (t) =>
    !["ATP", "WTA", "TENNIS"].includes(t.sport),

  // [T2] Lift block, but only allow tennis at price >= 0.70
  "T2: Tennis allowed at price >= 0.70 only": (t) => {
    if (["ATP", "WTA", "TENNIS"].includes(t.sport)) {
      return t.leaderPrice >= 0.70;
    }
    return true;
  },

  // [T3] Lift block, only ATP allowed (no WTA), price >= 0.70
  "T3: ATP only (no WTA), price >= 0.70": (t) => {
    if (t.sport === "ATP") return t.leaderPrice >= 0.70;
    if (["WTA", "TENNIS"].includes(t.sport)) return false;
    return true;
  },

  // [T4] Lift block fully - allow all tennis (for comparison)
  "T4: Tennis fully allowed (no filter)": (t) => true,

  // ────────────────────────────────────────────────────────────────────────
  // MLB SCENARIOS
  // ────────────────────────────────────────────────────────────────────────

  // [M1] MLB: Max price 0.80 (cut off 0.80–0.88)
  "M1: MLB max price 0.80 (cut high end)": (t) => {
    if (t.sport === "MLB") return t.leaderPrice <= 0.80;
    return true;
  },

  // [M2] MLB: Skip 20-24 UTC entries
  "M2: MLB skip 20-24 UTC entries": (t) => {
    if (t.sport === "MLB") return !(t.hourUtc >= 20 && t.hourUtc < 24);
    return true;
  },

  // [M3] MLB: Both — max 0.80 AND skip 20-24 UTC
  "M3: MLB max 0.80 + skip 20-24 UTC": (t) => {
    if (t.sport === "MLB") {
      return t.leaderPrice <= 0.80 && !(t.hourUtc >= 20 && t.hourUtc < 24);
    }
    return true;
  },

  // [M4] MLB: sweet spot only — price 0.60-0.75 (the two profitable bands)
  "M4: MLB price 0.60-0.75 only": (t) => {
    if (t.sport === "MLB") return t.leaderPrice >= 0.60 && t.leaderPrice < 0.75;
    return true;
  },

  // ────────────────────────────────────────────────────────────────────────
  // COMBINED SCENARIOS
  // ────────────────────────────────────────────────────────────────────────

  // [C1] Best guess combination: Tennis >= 0.70 only + MLB max 0.80
  "C1: Tennis >= 0.70 + MLB <= 0.80": (t) => {
    if (["ATP", "WTA", "TENNIS"].includes(t.sport)) return t.leaderPrice >= 0.70;
    if (t.sport === "MLB") return t.leaderPrice <= 0.80;
    return true;
  },

  // [C2] Best guess combination: ATP only >= 0.70 + MLB max 0.80 + skip 20-24 UTC MLB
  "C2: ATP >= 0.70 + MLB <= 0.80 + skip 20-24": (t) => {
    if (t.sport === "ATP") return t.leaderPrice >= 0.70;
    if (["WTA", "TENNIS"].includes(t.sport)) return false;
    if (t.sport === "MLB") return t.leaderPrice <= 0.80 && !(t.hourUtc >= 20 && t.hourUtc < 24);
    return true;
  },
};

// ═══════════════════════════════════════════════════════════════════════════
// RUN SIMULATIONS
// ═══════════════════════════════════════════════════════════════════════════
function runScenario(trades, filterFn) {
  const kept   = trades.filter(filterFn);
  const removed = trades.filter(t => !filterFn(t));
  return { kept, removed };
}

function printScenario(name, liveKept, liveRemoved, p2Kept, p2Removed) {
  const ls = summarise(liveKept);
  const ps = summarise(p2Kept);
  const lsBasePnl = summarise([...liveKept, ...liveRemoved]).pnl;
  const psBasePnl = summarise([...p2Kept, ...p2Removed]).pnl;
  const lDelta = ls.pnl - lsBasePnl;
  const pDelta = ps.pnl - psBasePnl;
  return {
    scenario: name,
    "live_n": ls.n,
    "live_win%": ls.winRate,
    "live_pnl": fmt(ls.pnl),
    "live_Δ vs actual": fmt(lDelta),
    "p2_n": ps.n,
    "p2_win%": ps.winRate,
    "p2_pnl": fmt(ps.pnl),
    "p2_Δ vs actual": fmt(pDelta),
  };
}

const baselineLive = summarise(liveTrades);
const baselineP2   = summarise(p2Trades);

console.log(`\n${"═".repeat(80)}`);
console.log("COUNTERFACTUAL SIMULATION");
console.log(`Baseline — Live: ${baselineLive.n} trades, ${baselineLive.winRate} win, ${fmt(baselineLive.pnl)}`);
console.log(`Baseline — Paper-v2: ${baselineP2.n} trades, ${baselineP2.winRate} win, ${fmt(baselineP2.pnl)}`);
console.log(`${"═".repeat(80)}`);

const rows = [];
for (const [name, filterFn] of Object.entries(scenarios)) {
  const { kept: lk, removed: lr } = runScenario(liveTrades, filterFn);
  const { kept: pk, removed: pr } = runScenario(p2Trades, filterFn);
  rows.push(printScenario(name, lk, lr, pk, pr));
}
console.table(rows);

// ── Detailed breakdown of T2 (the tennis lift scenario) ──────────────────────
console.log(`\n${"─".repeat(80)}`);
console.log("DETAIL: T2 — Tennis allowed at price >= 0.70 (removed trades breakdown)");
console.log(`${"─".repeat(80)}`);

for (const [label, trades] of [["LIVE", liveTrades], ["PAPER-V2", p2Trades]]) {
  const tennisTrades = trades.filter(t => ["ATP","WTA","TENNIS"].includes(t.sport));
  const wouldKeep   = tennisTrades.filter(t => t.leaderPrice >= 0.70);
  const wouldBlock  = tennisTrades.filter(t => t.leaderPrice < 0.70);
  const keepStats   = summarise(wouldKeep);
  const blockStats  = summarise(wouldBlock);
  console.log(`\n[${label}] Tennis: total=${tennisTrades.length}`);
  console.log(`  KEEP (price >= 0.70): n=${keepStats.n}, win=${keepStats.winRate}, pnl=${fmt(keepStats.pnl)}`);
  console.log(`  BLOCK (price < 0.70): n=${blockStats.n}, win=${blockStats.winRate}, pnl=${fmt(blockStats.pnl)}`);
  console.log(`  → Currently BLOCKING ALL tennis. If we lift the block with price>=0.70:`);
  console.log(`    We'd gain ${fmt(keepStats.pnl)} from the kept trades`);
  console.log(`    We'd also gain ${fmt(blockStats.pnl)} from the newly-blocked-by-filter trades`);
  console.log(`    Net: we'd gain ${fmt(keepStats.pnl + blockStats.pnl)} vs current (all blocked)`);
}

// ── Detailed breakdown of M3 (MLB combined) ───────────────────────────────────
console.log(`\n${"─".repeat(80)}`);
console.log("DETAIL: M3 — MLB max 0.80 + skip 20-24 UTC (what gets removed)");
console.log(`${"─".repeat(80)}`);

for (const [label, trades] of [["LIVE", liveTrades], ["PAPER-V2", p2Trades]]) {
  const mlb = trades.filter(t => t.sport === "MLB");
  const kept    = mlb.filter(t => t.leaderPrice <= 0.80 && !(t.hourUtc >= 20 && t.hourUtc < 24));
  const removed = mlb.filter(t => !(t.leaderPrice <= 0.80 && !(t.hourUtc >= 20 && t.hourUtc < 24)));
  const removedByPrice  = mlb.filter(t => t.leaderPrice > 0.80);
  const removedByTime   = mlb.filter(t => t.leaderPrice <= 0.80 && t.hourUtc >= 20 && t.hourUtc < 24);
  console.log(`\n[${label}] MLB: total=${mlb.length}`);
  console.table([
    { segment: "KEPT (price<=0.80, not 20-24 UTC)", ...summarise(kept) },
    { segment: "REMOVED (all filtered-out MLB)", ...summarise(removed) },
    { segment: "  → removed by price > 0.80", ...summarise(removedByPrice) },
    { segment: "  → removed by 20-24 UTC only", ...summarise(removedByTime) },
  ]);
}

// ── C1 combined scenario sport-by-sport impact ────────────────────────────────
console.log(`\n${"─".repeat(80)}`);
console.log("DETAIL: C1 — Tennis>=0.70 + MLB<=0.80 — impact by sport");
console.log(`${"─".repeat(80)}`);

const c1Filter = scenarios["C1: Tennis >= 0.70 + MLB <= 0.80"];
for (const [label, trades] of [["LIVE", liveTrades], ["PAPER-V2", p2Trades]]) {
  const sports = [...new Set(trades.map(t => t.sport))].sort();
  const sportRows = sports.map(sport => {
    const sportTrades = trades.filter(t => t.sport === sport);
    const kept = sportTrades.filter(c1Filter);
    const removed = sportTrades.filter(t => !c1Filter(t));
    const ks = summarise(kept);
    const rs = summarise(removed);
    return {
      sport,
      "original_n": sportTrades.length,
      "original_pnl": fmt(summarise(sportTrades).pnl),
      "after_filter_n": ks.n,
      "after_filter_pnl": fmt(ks.pnl),
      "removed_n": rs.n,
      "removed_pnl": fmt(rs.pnl),
    };
  });
  console.log(`\n[${label}]:`);
  console.table(sportRows);
}

await prisma.$disconnect();
