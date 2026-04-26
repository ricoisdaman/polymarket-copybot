// Cross-profile P&L analysis: live vs paper-v2 on the same markets
// For live: there are no SELL fills (markets settle, not traded out),
// so we use paper-v2's SELL fill price on the same tokenId as the exit price.
// This is accurate because both bots held the same token; same settlement outcome.

import { PrismaClient } from "./packages/db/node_modules/@prisma/client/index.js";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbUrl = "file:" + path.resolve(__dirname, "./packages/db/prisma/dev.db").replace(/\\/g, "/");
const prisma = new PrismaClient({ datasources: { db: { url: dbUrl } } });

// ── helpers ───────────────────────────────────────────────────────────────────
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

function stats(trades) {
  if (trades.length === 0) return { n: 0, wins: 0, losses: 0, winRate: "-", pnl: "$0.00", avgWin: "-", avgLoss: "-", lossWinRatio: "-" };
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const total = trades.reduce((s, t) => s + t.pnl, 0);
  const avgWin = wins.length ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0;
  const avgLoss = losses.length ? losses.reduce((s, t) => s + t.pnl, 0) / losses.length : 0;
  const ratio = avgWin !== 0 ? Math.abs(avgLoss / avgWin) : 0;
  return {
    n: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: `${((wins.length / trades.length) * 100).toFixed(0)}%`,
    pnl: `$${total.toFixed(2)}`,
    avgWin: `$${avgWin.toFixed(2)}`,
    avgLoss: `$${avgLoss.toFixed(2)}`,
    lossWinRatio: ratio.toFixed(2) + "x",
  };
}

function breakdown(trades, keyFn, label) {
  const groups = {};
  for (const t of trades) {
    const k = keyFn(t);
    if (!groups[k]) groups[k] = [];
    groups[k].push(t);
  }
  return Object.entries(groups)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([key, ts]) => ({ [label]: key, ...stats(ts) }));
}

// ── Step 1: Build paper-v2 exit price map (tokenId → avg exit price) ──────────
// This is the sell price the leader exited at — same settlement price live got.
const p2Sells = await prisma.$queryRawUnsafe(`
  SELECT ci.tokenId,
    SUM(f.price * f.size) / SUM(f.size) as avgExitPrice,
    SUM(f.price * f.size) as totalProceeds,
    SUM(f.size) as totalShares
  FROM CopyIntent ci
  JOIN "Order" o ON o.intentId = ci.id
  JOIN Fill f ON f.orderId = o.id
  WHERE ci.profileId = 'paper-v2' AND ci.side = 'SELL' AND o.side = 'SELL'
  GROUP BY ci.tokenId
`);
const exitPriceMap = {};
for (const row of p2Sells) {
  exitPriceMap[row.tokenId] = {
    avgExitPrice: Number(row.avgExitPrice),
    totalProceeds: Number(row.totalProceeds),
    totalShares: Number(row.totalShares),
  };
}
console.log(`\nBuilt exit price map from paper-v2: ${Object.keys(exitPriceMap).length} tokens`);

// ── Step 2: Load live BUY fills grouped by tokenId ────────────────────────────
const liveBuys = await prisma.$queryRawUnsafe(`
  SELECT ci.tokenId, ci.id as intentId, ci.ts as intentTs,
    le.rawJson, le.price as leaderPrice, ci.leaderSize as leaderUsdc,
    SUM(f.price * f.size) as fillCost,
    SUM(f.size) as fillShares
  FROM CopyIntent ci
  JOIN LeaderEvent le ON ci.leaderEventId = le.id
  JOIN "Order" o ON o.intentId = ci.id
  JOIN Fill f ON f.orderId = o.id
  WHERE ci.profileId = 'live' AND ci.side = 'BUY' AND o.side = 'BUY'
  GROUP BY ci.id
`);
console.log(`Live BUY intents with fills: ${liveBuys.length}`);

// ── Step 3: Load paper-v2 BUY fills too (for direct side-by-side) ────────────
const p2Buys = await prisma.$queryRawUnsafe(`
  SELECT ci.tokenId, ci.id as intentId, ci.ts as intentTs,
    le.rawJson, le.price as leaderPrice, ci.leaderSize as leaderUsdc,
    SUM(f.price * f.size) as fillCost,
    SUM(f.size) as fillShares
  FROM CopyIntent ci
  JOIN LeaderEvent le ON ci.leaderEventId = le.id
  JOIN "Order" o ON o.intentId = ci.id
  JOIN Fill f ON f.orderId = o.id
  WHERE ci.profileId = 'paper-v2' AND ci.side = 'BUY' AND o.side = 'BUY'
  GROUP BY ci.id
`);
console.log(`Paper-v2 BUY intents with fills: ${p2Buys.length}`);

// ── Step 4: Get open positions so we can skip them ────────────────────────────
const liveOpen = new Set(
  (await prisma.position.findMany({ where: { profileId: "live", size: { gt: 0.01 } } }))
    .map(p => p.tokenId)
);
const p2Open = new Set(
  (await prisma.position.findMany({ where: { profileId: "paper-v2", size: { gt: 0.01 } } }))
    .map(p => p.tokenId)
);
console.log(`Live open positions: ${liveOpen.size} | Paper-v2 open: ${p2Open.size}`);

// ── Step 5: Build trade records for each profile ──────────────────────────────
function buildTrades(buys, openSet, exitMap, profileLabel) {
  const trades = [];
  for (const row of buys) {
    const tokenId = row.tokenId;
    if (openSet.has(tokenId)) continue;  // not yet resolved

    const exit = exitMap[tokenId];
    if (!exit) continue;  // no exit data = skip (shouldn't happen for p2-cross-ref)

    let raw = {};
    try { raw = JSON.parse(row.rawJson); } catch {}
    const slug = (raw.slug ?? raw.eventSlug ?? "").toLowerCase();
    const sport = slugSport(slug);
    const cost = Number(row.fillCost);
    const shares = Number(row.fillShares);
    const proceeds = exit.avgExitPrice * shares;
    const pnl = proceeds - cost;

    const intentTs = new Date(row.intentTs);
    const hourUtc = intentTs.getUTCHours();
    const dayOfWeek = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][intentTs.getUTCDay()];

    trades.push({
      profile: profileLabel,
      tokenId, slug, sport, pnl, cost, shares,
      leaderPrice: Number(row.leaderPrice),
      leaderUsdc: Number(row.leaderUsdc),
      exitPrice: exit.avgExitPrice,
      hourUtc, dayOfWeek,
    });
  }
  return trades;
}

// For paper-v2 we use its own exit map (self-referential)
const p2ExitSelf = {};
for (const row of p2Sells) {
  p2ExitSelf[row.tokenId] = {
    avgExitPrice: Number(row.avgExitPrice),
    totalProceeds: Number(row.totalProceeds),
    totalShares: Number(row.totalShares),
  };
}

const liveTrades = buildTrades(liveBuys, liveOpen, exitPriceMap, "live");
const p2Trades   = buildTrades(p2Buys, p2Open, p2ExitSelf, "paper-v2");

// ── Trades that both bots took on the same market ─────────────────────────────
const liveTokenIds = new Set(liveTrades.map(t => t.tokenId));
const p2TokenIds   = new Set(p2Trades.map(t => t.tokenId));
const sharedTokenIds = new Set([...liveTokenIds].filter(id => p2TokenIds.has(id)));

const liveShared = liveTrades.filter(t => sharedTokenIds.has(t.tokenId));
const p2Shared   = p2Trades.filter(t => sharedTokenIds.has(t.tokenId));

console.log(`\nTokens traded by BOTH live and paper-v2: ${sharedTokenIds.size}`);
console.log(`Live resolved trades with exit data: ${liveTrades.length}`);
console.log(`Paper-v2 resolved trades: ${p2Trades.length}`);

// ═══════════════════════════════════════════════════════════════════════════════
console.log(`\n${"═".repeat(70)}`);
console.log("OVERALL PERFORMANCE COMPARISON (resolved trades only)");
console.log(`${"═".repeat(70)}`);
console.table([
  { profile: "LIVE",     ...stats(liveTrades) },
  { profile: "PAPER-V2", ...stats(p2Trades) },
]);

console.log(`\n${"═".repeat(70)}`);
console.log("SHARED MARKETS ONLY — same tokens both bots traded");
console.log(`${"═".repeat(70)}`);
console.table([
  { profile: "LIVE (shared)",     ...stats(liveShared) },
  { profile: "PAPER-V2 (shared)", ...stats(p2Shared) },
]);

// ── Sport breakdown for each profile ─────────────────────────────────────────
console.log(`\n${"═".repeat(70)}`);
console.log("SPORT BREAKDOWN — LIVE");
console.log(`${"═".repeat(70)}`);
console.table(breakdown(liveTrades, t => t.sport, "sport"));

console.log(`\n${"═".repeat(70)}`);
console.log("SPORT BREAKDOWN — PAPER-V2");
console.log(`${"═".repeat(70)}`);
console.table(breakdown(p2Trades, t => t.sport, "sport"));

// ── Tennis deep dive ──────────────────────────────────────────────────────────
for (const [label, trades] of [["LIVE", liveTrades], ["PAPER-V2", p2Trades]]) {
  const tennis = trades.filter(t => ["ATP","WTA","TENNIS"].includes(t.sport));
  if (tennis.length === 0) continue;
  console.log(`\n${"─".repeat(60)}`);
  console.log(`TENNIS — ${label} (${tennis.length} resolved trades)`);
  console.log(`${"─".repeat(60)}`);
  console.log("By tour:");
  console.table(breakdown(tennis, t => t.sport, "tour"));
  console.log("By price band (0.05 buckets):");
  console.table(breakdown(tennis, t => {
    const lo = (Math.floor(t.leaderPrice * 20) / 20).toFixed(2);
    const hi = ((Math.floor(t.leaderPrice * 20) + 1) / 20).toFixed(2);
    return `${lo}-${hi}`;
  }, "priceBand"));
  console.log("By leader size:");
  console.table(breakdown(tennis, t => {
    if (t.leaderUsdc < 10) return "a.<$10";
    if (t.leaderUsdc < 25) return "b.$10-25";
    if (t.leaderUsdc < 50) return "c.$25-50";
    if (t.leaderUsdc < 100) return "d.$50-100";
    return "e.$100+";
  }, "leaderSize"));
  console.log("Top 10 biggest losses:");
  [...tennis].filter(t => t.pnl < 0).sort((a,b) => a.pnl - b.pnl).slice(0,10).forEach(t =>
    console.log(`  ${t.sport.padEnd(4)} p=${t.leaderPrice.toFixed(3)} exit=${t.exitPrice.toFixed(3)} leader=$${t.leaderUsdc.toFixed(2)} pnl=$${t.pnl.toFixed(2)} ${t.slug}`)
  );
  console.log("Top 10 biggest wins:");
  [...tennis].filter(t => t.pnl > 0).sort((a,b) => b.pnl - a.pnl).slice(0,10).forEach(t =>
    console.log(`  ${t.sport.padEnd(4)} p=${t.leaderPrice.toFixed(3)} exit=${t.exitPrice.toFixed(3)} leader=$${t.leaderUsdc.toFixed(2)} pnl=$${t.pnl.toFixed(2)} ${t.slug}`)
  );
}

// ── MLB deep dive ─────────────────────────────────────────────────────────────
for (const [label, trades] of [["LIVE", liveTrades], ["PAPER-V2", p2Trades]]) {
  const mlb = trades.filter(t => t.sport === "MLB");
  if (mlb.length === 0) continue;
  console.log(`\n${"─".repeat(60)}`);
  console.log(`MLB — ${label} (${mlb.length} resolved trades)`);
  console.log(`${"─".repeat(60)}`);
  console.log("By price band (0.05 buckets):");
  console.table(breakdown(mlb, t => {
    const lo = (Math.floor(t.leaderPrice * 20) / 20).toFixed(2);
    const hi = ((Math.floor(t.leaderPrice * 20) + 1) / 20).toFixed(2);
    return `${lo}-${hi}`;
  }, "priceBand"));
  console.log("By day of week:");
  console.table(breakdown(mlb, t => t.dayOfWeek, "day"));
  console.log("By hour UTC (4h buckets):");
  console.table(breakdown(mlb, t => {
    const b = Math.floor(t.hourUtc / 4) * 4;
    return `${String(b).padStart(2,"0")}-${String(b+4).padStart(2,"0")} UTC`;
  }, "timeUTC"));
  console.log("Top 10 biggest losses:");
  [...mlb].filter(t => t.pnl < 0).sort((a,b) => a.pnl - b.pnl).slice(0,10).forEach(t =>
    console.log(`  p=${t.leaderPrice.toFixed(3)} exit=${t.exitPrice.toFixed(3)} leader=$${t.leaderUsdc.toFixed(2)} pnl=$${t.pnl.toFixed(2)} ${t.slug}`)
  );
}

// ── Side-by-side on shared tokens ─────────────────────────────────────────────
console.log(`\n${"═".repeat(70)}`);
console.log("SHARED MARKET DEEP DIVE — sport x profile comparison");
console.log(`${"═".repeat(70)}`);
const allSports = [...new Set([...liveShared, ...p2Shared].map(t => t.sport))].sort();
for (const sport of allSports) {
  const lSport = liveShared.filter(t => t.sport === sport);
  const pSport = p2Shared.filter(t => t.sport === sport);
  if (lSport.length === 0 && pSport.length === 0) continue;
  console.table([
    { profile: `LIVE / ${sport}`,     ...stats(lSport) },
    { profile: `PAPER-V2 / ${sport}`, ...stats(pSport) },
  ]);
}

await prisma.$disconnect();
