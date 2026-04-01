/**
 * check-leader-drift.mjs
 * Compares the bot's open DB positions against what the leader currently holds on Polymarket.
 * Flags any position the bot is still sitting in that the leader has already exited.
 *
 * Usage (from project root):
 *   pnpm --filter @copybot/db exec node scripts/check-leader-drift.mjs
 *   pnpm --filter @copybot/db exec node scripts/check-leader-drift.mjs leader2 ../../.env.leader2
 *
 * Arguments:
 *   [1] profileId   — DB profile to check (default: value from .env or "default")
 *   [2] envFile     — path to env file relative to this script, defaults to ../../../.env
 */

import { PrismaClient } from "@prisma/client";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Load env file ──────────────────────────────────────────────────────────────
const envFileArg = process.argv[3]; // optional override
const defaultEnvPath = path.resolve(__dirname, "../../../.env");
const envPath = envFileArg
  ? path.resolve(__dirname, envFileArg)
  : defaultEnvPath;

const env = {};
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx < 1) continue;
    env[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
  }
} else {
  console.warn(`[warn] Env file not found: ${envPath} — using process.env only`);
}

const profileId = process.argv[2] ?? env["PROFILE_ID"] ?? "default";
const leaderWallet = env["LEADER_WALLET"] ?? process.env.LEADER_WALLET ?? "";
const dataApiBase = (env["POLYMARKET_DATA_API_URL"] ?? process.env.POLYMARKET_DATA_API_URL ?? "https://data-api.polymarket.com").replace(/\/$/, "");

if (!leaderWallet) {
  console.error("ERROR: LEADER_WALLET not set in env file. Aborting.");
  process.exit(1);
}

const dbPath = path.resolve(__dirname, "../prisma/dev.db").replace(/\\/g, "/");
const prisma = new PrismaClient({ datasources: { db: { url: `file:${dbPath}` } } });

console.log(`\n${"=".repeat(60)}`);
console.log(` LEADER DRIFT CHECK`);
console.log(` Profile : ${profileId}`);
console.log(` Leader  : ${leaderWallet}`);
console.log(` Data API: ${dataApiBase}`);
console.log(`${"=".repeat(60)}\n`);

// ── 1. Fetch leader's current Polymarket positions ─────────────────────────────
let leaderPositions = [];
let leaderApiOk = false;
try {
  const url = `${dataApiBase}/positions?user=${encodeURIComponent(leaderWallet)}&sizeThreshold=0.01`;
  console.log(`Fetching leader positions from:\n  ${url}\n`);
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const payload = await res.json();
  leaderPositions = Array.isArray(payload) ? payload : (payload.data ?? payload.positions ?? []);
  leaderApiOk = true;
  console.log(`Leader currently holds ${leaderPositions.length} position(s) on Polymarket.`);
} catch (err) {
  console.warn(`[warn] Could not fetch leader positions: ${err.message}`);
  console.warn(`[warn] Drift detection will be skipped — bot positions shown for reference only.\n`);
}

// Build set of tokenIds the leader currently holds (non-zero size)
const leaderHolds = new Set(
  leaderPositions
    .map((p) => String(p.asset ?? p.tokenId ?? p.token_id ?? "").trim())
    .filter(Boolean)
);

// ── 2. Fetch bot's open positions from DB ─────────────────────────────────────
const botPositions = await prisma.position.findMany({
  where: { profileId, size: { gt: 0 } },
  select: { tokenId: true, size: true, avgPrice: true, updatedAt: true },
  orderBy: { updatedAt: "desc" }
});

// ── 3. Fetch market titles from stored leader events ──────────────────────────
const tokenIds = botPositions.map((p) => p.tokenId);
const titleMap = new Map();
if (tokenIds.length > 0) {
  const events = await prisma.leaderEvent.findMany({
    where: { profileId, tokenId: { in: tokenIds } },
    orderBy: { ts: "desc" },
    select: { tokenId: true, rawJson: true }
  });
  for (const ev of events) {
    if (titleMap.has(ev.tokenId)) continue;
    try {
      const parsed = JSON.parse(ev.rawJson);
      if (typeof parsed.title === "string" && parsed.title.trim()) {
        titleMap.set(ev.tokenId, parsed.title.trim());
      }
    } catch {
      // ignore unparseable
    }
  }
}

// ── 4. Print results ──────────────────────────────────────────────────────────
if (botPositions.length === 0) {
  console.log("Bot has no open positions. Nothing to check.\n");
  await prisma.$disconnect();
  process.exit(0);
}

console.log(`\nBot open positions (${botPositions.length}):\n`);

let missedSells = 0;
for (const pos of botPositions) {
  const title = (titleMap.get(pos.tokenId) ?? pos.tokenId).slice(0, 72);
  const cost = (pos.size * pos.avgPrice).toFixed(2);

  let status;
  if (!leaderApiOk) {
    status = "  [?] (leader API unavailable — cannot determine)";
  } else if (leaderHolds.has(pos.tokenId)) {
    status = "  ✅  Leader still holds — no action needed";
  } else {
    status = "  ⚠️   LEADER EXITED — bot missed the SELL signal";
    missedSells++;
  }

  console.log(`  ${title}`);
  console.log(`    Token : ${pos.tokenId}`);
  console.log(`    Size  : ${pos.size.toFixed(6)} shares @ avg $${pos.avgPrice.toFixed(4)}  (cost basis: $${cost})`);
  console.log(`    Last  : ${pos.updatedAt.toISOString()}`);
  console.log(status);
  console.log();
}

// ── 5. Summary ────────────────────────────────────────────────────────────────
console.log("=".repeat(60));
if (!leaderApiOk) {
  console.log(" Could not reach leader API — rerun when network is available.");
} else if (missedSells === 0) {
  console.log(" ✅  No drift detected. All bot positions match leader holdings.");
} else {
  console.log(` ⚠️   ${missedSells} MISSED SELL(S) detected.`);
  console.log();
  console.log(" What to do:");
  console.log("   PAPER mode : These are bookkeeping only. Restart the bot —");
  console.log("                it will resume copying the leader's future trades.");
  console.log("                The missed sells mean your P&L tracking will be slightly");
  console.log("                off until those markets resolve.");
  console.log("   LIVE mode  : You still hold real shares the leader no longer holds.");
  console.log("                Consider manually selling via Polymarket UI.");
}
console.log("=".repeat(60));
console.log();

await prisma.$disconnect();
