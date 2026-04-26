// Deep-dive analysis: Tennis (ATP vs WTA breakdown) and MLB
// Uses paper-v2 resolved trades for statistical power, then checks live profile too.

import { PrismaClient } from "./packages/db/node_modules/@prisma/client/index.js";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbUrl = "file:" + path.resolve(__dirname, "./packages/db/prisma/dev.db").replace(/\\/g, "/");
const prisma = new PrismaClient({ datasources: { db: { url: dbUrl } } });

// ── helpers ──────────────────────────────────────────────────────────────────
function stats(trades) {
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl < 0);
  const total = trades.reduce((s, t) => s + t.pnl, 0);
  const avgWin = wins.length ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0;
  const avgLoss = losses.length ? losses.reduce((s, t) => s + t.pnl, 0) / losses.length : 0;
  const ratio = avgLoss !== 0 ? Math.abs(avgLoss / avgWin) : 0;
  return {
    n: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: trades.length ? `${((wins.length / trades.length) * 100).toFixed(0)}%` : "-",
    pnl: `$${total.toFixed(2)}`,
    avgWin: `$${avgWin.toFixed(2)}`,
    avgLoss: `$${avgLoss.toFixed(2)}`,
    lossWinRatio: ratio.toFixed(2) + "x",
  };
}

function printTable(title, rows) {
  console.log(`\n=== ${title} ===`);
  console.table(rows);
}

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

// ── load resolved paper-v2 fills ─────────────────────────────────────────────
async function loadResolvedFills(profileId) {
  // Get all fills joined to copy intent + leader event
  const rows = await prisma.$queryRawUnsafe(`
    SELECT
      ci.id as intentId,
      ci.tokenId,
      ci.side,
      ci.desiredNotional,
      ci.leaderSize as leaderUsdc,
      ci.ts as intentTs,
      le.rawJson,
      le.price as leaderPrice,
      SUM(f.price * f.size) as fillCost,
      SUM(f.size) as fillShares
    FROM CopyIntent ci
    JOIN LeaderEvent le ON ci.leaderEventId = le.id
    JOIN "Order" o ON o.intentId = ci.id
    JOIN Fill f ON f.orderId = o.id
    WHERE ci.profileId = '${profileId}'
      AND ci.side = 'BUY'
      AND o.side = 'BUY'
    GROUP BY ci.id
  `);

  // Now get SELL fills for matching tokenIds to compute P&L
  const sellRows = await prisma.$queryRawUnsafe(`
    SELECT
      ci.tokenId,
      SUM(f.price * f.size) as sellProceeds,
      SUM(f.size) as sellShares
    FROM CopyIntent ci
    JOIN "Order" o ON o.intentId = ci.id
    JOIN Fill f ON f.orderId = o.id
    WHERE ci.profileId = '${profileId}'
      AND ci.side = 'SELL'
      AND o.side = 'SELL'
    GROUP BY ci.tokenId
  `);

  const sellMap = {};
  for (const s of sellRows) {
    sellMap[s.tokenId] = { proceeds: Number(s.sellProceeds), shares: Number(s.sellShares) };
  }

  // Also check Position table for unrealized positions (not closed = skip for resolved analysis)
  const openPositions = await prisma.position.findMany({ where: { profileId } });
  const openTokenIds = new Set(openPositions.filter((p) => p.size > 0.01).map((p) => p.tokenId));

  const trades = [];
  for (const row of rows) {
    const tokenId = row.tokenId;
    // Skip still-open positions
    if (openTokenIds.has(tokenId)) continue;

    let raw = {};
    try { raw = JSON.parse(row.rawJson); } catch {}
    const slug = (raw.slug ?? raw.eventSlug ?? "").toLowerCase();
    const sport = slugSport(slug);
    const title = raw.title ?? raw.question ?? raw.outcome ?? "";

    const cost = Number(row.fillCost);
    const shares = Number(row.fillShares);

    const sell = sellMap[tokenId];
    let pnl;
    if (sell && sell.shares >= shares * 0.8) {
      // Properly sold
      pnl = sell.proceeds - cost;
    } else {
      // Resolved at 0 (full loss) — no sell recorded means expired worthless
      pnl = -cost;
    }

    const intentTs = new Date(row.intentTs);
    const hourUtc = intentTs.getUTCHours();
    const dayOfWeek = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][intentTs.getUTCDay()];
    const priceBand = `${(Math.floor(Number(row.leaderPrice) * 10) / 10).toFixed(1)}-${(Math.ceil(Number(row.leaderPrice) * 10) / 10).toFixed(1)}`;

    let outcomeIndex = -1;
    try {
      // outcomeIndex tells us which outcome of the market (0=first/home, 1=second/away)
      const outcomes = raw.clobTokenIds ?? raw.outcomes ?? [];
      const idx = outcomes.indexOf(tokenId);
      outcomeIndex = idx;
    } catch {}

    trades.push({
      tokenId, slug, sport, title, pnl, cost, shares,
      leaderPrice: Number(row.leaderPrice),
      leaderUsdc: Number(row.leaderUsdc),
      hourUtc, dayOfWeek, priceBand, outcomeIndex,
    });
  }

  return trades;
}

// ── breakdown helper ──────────────────────────────────────────────────────────
function breakdown(trades, keyFn, label) {
  const groups = {};
  for (const t of trades) {
    const k = keyFn(t);
    if (!groups[k]) groups[k] = [];
    groups[k].push(t);
  }
  const rows = Object.entries(groups)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([key, ts]) => ({ [label]: key, ...stats(ts) }));
  return rows;
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════

for (const profileId of ["paper-v2", "live"]) {
  const allTrades = await loadResolvedFills(profileId);
  if (allTrades.length === 0) {
    console.log(`\n[${profileId}] No resolved trades found — skipping.`);
    continue;
  }

  const tennisTrades = allTrades.filter((t) => ["ATP", "WTA", "TENNIS"].includes(t.sport));
  const mlbTrades = allTrades.filter((t) => t.sport === "MLB");

  console.log(`\n${"═".repeat(70)}`);
  console.log(`PROFILE: ${profileId}  |  Total resolved: ${allTrades.length}  |  Tennis: ${tennisTrades.length}  |  MLB: ${mlbTrades.length}`);
  console.log(`${"═".repeat(70)}`);

  // ── TENNIS ──────────────────────────────────────────────────────────────
  if (tennisTrades.length > 0) {
    console.log(`\n${"─".repeat(50)}`);
    console.log(`TENNIS ANALYSIS (${tennisTrades.length} resolved trades)`);
    console.log(`─`.repeat(50));

    // Overall
    printTable("Tennis overall", [{ group: "ALL TENNIS", ...stats(tennisTrades) }]);

    // ATP vs WTA vs other
    printTable("By tour (ATP / WTA)", breakdown(tennisTrades, (t) => t.sport, "tour"));

    // By price band
    printTable("By leader price band", breakdown(tennisTrades, (t) => t.priceBand, "priceBand"));

    // By outcome index
    printTable("By outcome index (0=first-named/top-seeded, 1=second-named)", 
      breakdown(tennisTrades, (t) => t.outcomeIndex === -1 ? "unknown" : `idx${t.outcomeIndex}`, "outcomeIdx"));

    // By leader bet size
    printTable("By leader USDC size", breakdown(tennisTrades, (t) => {
      if (t.leaderUsdc < 10) return "<$10";
      if (t.leaderUsdc < 25) return "$10-25";
      if (t.leaderUsdc < 50) return "$25-50";
      if (t.leaderUsdc < 100) return "$50-100";
      return "$100+";
    }, "leaderSize"));

    // By time bucket
    printTable("By hour UTC (4h buckets)", breakdown(tennisTrades, (t) => {
      const b = Math.floor(t.hourUtc / 4) * 4;
      return `${String(b).padStart(2,"0")}-${String(b+4).padStart(2,"0")} UTC`;
    }, "timeUTC"));

    // Biggest losses
    console.log(`\n--- Tennis: 10 biggest losses ---`);
    const bigLosses = [...tennisTrades].filter(t => t.pnl < 0).sort((a, b) => a.pnl - b.pnl).slice(0, 10);
    for (const t of bigLosses) {
      console.log(`  ${t.sport.padEnd(4)}  p=${t.leaderPrice.toFixed(3)}  leader=$${t.leaderUsdc.toFixed(2)}  pnl=$${t.pnl.toFixed(2)}  slug=${t.slug}`);
    }

    console.log(`\n--- Tennis: 10 biggest wins ---`);
    const bigWins = [...tennisTrades].filter(t => t.pnl > 0).sort((a, b) => b.pnl - a.pnl).slice(0, 10);
    for (const t of bigWins) {
      console.log(`  ${t.sport.padEnd(4)}  p=${t.leaderPrice.toFixed(3)}  leader=$${t.leaderUsdc.toFixed(2)}  pnl=$${t.pnl.toFixed(2)}  slug=${t.slug}`);
    }
  }

  // ── MLB ──────────────────────────────────────────────────────────────────
  if (mlbTrades.length > 0) {
    console.log(`\n${"─".repeat(50)}`);
    console.log(`MLB ANALYSIS (${mlbTrades.length} resolved trades)`);
    console.log(`─`.repeat(50));

    printTable("MLB overall", [{ group: "ALL MLB", ...stats(mlbTrades) }]);

    printTable("By leader price band", breakdown(mlbTrades, (t) => t.priceBand, "priceBand"));

    printTable("By outcome index (0=first team, 1=second team)", 
      breakdown(mlbTrades, (t) => t.outcomeIndex === -1 ? "unknown" : `idx${t.outcomeIndex}`, "outcomeIdx"));

    printTable("By leader USDC size", breakdown(mlbTrades, (t) => {
      if (t.leaderUsdc < 10) return "<$10";
      if (t.leaderUsdc < 25) return "$10-25";
      if (t.leaderUsdc < 50) return "$25-50";
      if (t.leaderUsdc < 100) return "$50-100";
      return "$100+";
    }, "leaderSize"));

    printTable("By hour UTC (4h buckets)", breakdown(mlbTrades, (t) => {
      const b = Math.floor(t.hourUtc / 4) * 4;
      return `${String(b).padStart(2,"0")}-${String(b+4).padStart(2,"0")} UTC`;
    }, "timeUTC"));

    printTable("By day of week", breakdown(mlbTrades, (t) => t.dayOfWeek, "day"));

    // Breakdown by 2-decimal price to spot micro-patterns
    printTable("By exact price band (0.05 buckets)", breakdown(mlbTrades, (t) => {
      const lo = (Math.floor(t.leaderPrice * 20) / 20).toFixed(2);
      const hi = ((Math.floor(t.leaderPrice * 20) + 1) / 20).toFixed(2);
      return `${lo}-${hi}`;
    }, "priceBand"));

    console.log(`\n--- MLB: 10 biggest losses ---`);
    const bigLosses = [...mlbTrades].filter(t => t.pnl < 0).sort((a, b) => a.pnl - b.pnl).slice(0, 10);
    for (const t of bigLosses) {
      console.log(`  p=${t.leaderPrice.toFixed(3)}  leader=$${t.leaderUsdc.toFixed(2)}  pnl=$${t.pnl.toFixed(2)}  ${t.slug}`);
    }

    console.log(`\n--- MLB: 10 biggest wins ---`);
    const bigWins = [...mlbTrades].filter(t => t.pnl > 0).sort((a, b) => b.pnl - a.pnl).slice(0, 10);
    for (const t of bigWins) {
      console.log(`  p=${t.leaderPrice.toFixed(3)}  leader=$${t.leaderUsdc.toFixed(2)}  pnl=$${t.pnl.toFixed(2)}  ${t.slug}`);
    }
  }

  // ── Cross-sport comparison for reference ─────────────────────────────────
  printTable(`All sports summary (${profileId})`, breakdown(allTrades, (t) => t.sport, "sport"));
}

await prisma.$disconnect();
