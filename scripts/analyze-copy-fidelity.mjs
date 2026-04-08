import { readFileSync } from "node:fs";
import path from "node:path";

function parseEnv(filePath) {
  const env = {};
  const txt = readFileSync(filePath, "utf8");
  for (const line of txt.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const idx = t.indexOf("=");
    if (idx < 1) continue;
    env[t.slice(0, idx).trim()] = t.slice(idx + 1).trim();
  }
  return env;
}

function toMs(ts) {
  if (typeof ts === "number") return ts > 10_000_000_000 ? ts : ts * 1000;
  const d = Date.parse(String(ts ?? ""));
  return Number.isFinite(d) ? d : null;
}

function normalize(rec) {
  const ts = toMs(rec.timestamp ?? rec.ts ?? rec.time);
  const price = Number(rec.price ?? 0);
  const size = Number(rec.size ?? rec.amount ?? 0);
  const usdcSize = Number(rec.usdcSize ?? rec.usdc_size ?? price * size ?? 0);
  const side = String(rec.side ?? "").toUpperCase();
  const tokenId = String(rec.tokenId ?? rec.token_id ?? rec.asset ?? "");
  if (!ts || !tokenId || !Number.isFinite(price) || price <= 0 || !side) return null;
  return {
    id: String(rec.id ?? rec.transactionHash ?? rec.txHash ?? `${tokenId}-${ts}`),
    ts,
    side,
    price,
    size: Number.isFinite(size) ? size : 0,
    usdcSize: Number.isFinite(usdcSize) ? usdcSize : 0,
    tokenId,
    title: String(rec.title ?? rec.slug ?? "")
  };
}

async function fetchActivity(wallet, limit = 500) {
  const base = "https://data-api.polymarket.com";
  const url = `${base}/activity?user=${encodeURIComponent(wallet)}&limit=${limit}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const payload = await res.json();
  const rows = Array.isArray(payload) ? payload : Array.isArray(payload?.data) ? payload.data : [];
  return rows.map(normalize).filter(Boolean).sort((a, b) => a.ts - b.ts);
}

function stats(rows) {
  const out = { count: rows.length, buys: 0, sells: 0, buyNotional: 0, sellNotional: 0 };
  for (const r of rows) {
    if (r.side === "BUY") {
      out.buys += 1;
      out.buyNotional += r.usdcSize;
    } else if (r.side === "SELL") {
      out.sells += 1;
      out.sellNotional += r.usdcSize;
    }
  }
  return out;
}

function findMatches(leader, follower, maxLagMs = 20 * 60 * 1000) {
  const byTokenSide = new Map();
  for (const f of follower) {
    const k = `${f.tokenId}|${f.side}`;
    const arr = byTokenSide.get(k) ?? [];
    arr.push(f);
    byTokenSide.set(k, arr);
  }

  const matches = [];
  const unmatchedLeader = [];
  for (const l of leader) {
    const k = `${l.tokenId}|${l.side}`;
    const cands = byTokenSide.get(k) ?? [];
    let best = null;
    let bestLag = Infinity;
    for (const f of cands) {
      const lag = f.ts - l.ts;
      if (lag < 0 || lag > maxLagMs) continue;
      if (lag < bestLag) {
        bestLag = lag;
        best = f;
      }
    }
    if (!best) {
      unmatchedLeader.push(l);
    } else {
      let slipBps = 0;
      if (l.side === "BUY") slipBps = ((best.price - l.price) / l.price) * 10000;
      else slipBps = ((l.price - best.price) / l.price) * 10000;
      matches.push({ leader: l, follower: best, lagMs: bestLag, slipBps });
    }
  }
  return { matches, unmatchedLeader };
}

const env = parseEnv(path.resolve(".env"));
const leaderWallet = env.LEADER_WALLET;
const candidateFollowerWallets = [env.POLYMARKET_PROXY_WALLET, env.POLYMARKET_WALLET_ADDRESS].filter(Boolean);
if (!leaderWallet || candidateFollowerWallets.length === 0) {
  console.error("Missing LEADER_WALLET or follower wallet values in .env");
  process.exit(1);
}

const lookbackHours = Number(process.argv[2] ?? 48);
const since = Date.now() - lookbackHours * 60 * 60 * 1000;

const leaderAll = await fetchActivity(leaderWallet, 800);
const followerCandidates = [];
let bestFollower = { wallet: null, rows: [] };
for (const w of candidateFollowerWallets) {
  const rows = await fetchActivity(w, 800);
  const inWindow = rows.filter((r) => r.ts >= since);
  followerCandidates.push({ wallet: w, count: inWindow.length });
  if (inWindow.length > bestFollower.rows.length) {
    bestFollower = { wallet: w, rows: inWindow };
  }
}

const leader = leaderAll.filter((r) => r.ts >= since);
const follower = bestFollower.rows;

console.log(`Window: last ${lookbackHours}h`);
console.log(`Leader events   : ${leader.length}`);
for (const c of followerCandidates) {
  console.log(`Follower candidate ${c.wallet}: ${c.count} events`);
}
console.log(`Follower wallet : ${bestFollower.wallet}`);
console.log(`Follower events : ${follower.length}`);

const ls = stats(leader);
const fs = stats(follower);
console.log(`\nLeader: buys=${ls.buys}, sells=${ls.sells}, buyNotional=${ls.buyNotional.toFixed(2)}, sellNotional=${ls.sellNotional.toFixed(2)}`);
console.log(`Follower: buys=${fs.buys}, sells=${fs.sells}, buyNotional=${fs.buyNotional.toFixed(2)}, sellNotional=${fs.sellNotional.toFixed(2)}`);

const { matches, unmatchedLeader } = findMatches(leader, follower);
console.log(`\nMatched copy trades (same token+side, follower within 20m): ${matches.length}`);
console.log(`Leader trades with no follower match within 20m: ${unmatchedLeader.length}`);

const leaderTokens = new Set(leader.map((r) => r.tokenId));
const followerTokens = new Set(follower.map((r) => r.tokenId));
let tokenOverlap = 0;
for (const t of followerTokens) {
  if (leaderTokens.has(t)) tokenOverlap += 1;
}
console.log(`Unique token overlap in window: ${tokenOverlap} / follower ${followerTokens.size} / leader ${leaderTokens.size}`);

if (matches.length > 0) {
  const lags = matches.map((m) => m.lagMs / 1000);
  const slips = matches.map((m) => m.slipBps);
  const avgLag = lags.reduce((a, b) => a + b, 0) / lags.length;
  const avgSlip = slips.reduce((a, b) => a + b, 0) / slips.length;
  const sortedLag = [...lags].sort((a, b) => a - b);
  const sortedSlip = [...slips].sort((a, b) => a - b);
  const p50Lag = sortedLag[Math.floor(sortedLag.length * 0.5)];
  const p90Lag = sortedLag[Math.floor(sortedLag.length * 0.9)];
  const p50Slip = sortedSlip[Math.floor(sortedSlip.length * 0.5)];
  const p90Slip = sortedSlip[Math.floor(sortedSlip.length * 0.9)];
  console.log(`Lag seconds: avg=${avgLag.toFixed(1)}, p50=${p50Lag.toFixed(1)}, p90=${p90Lag.toFixed(1)}`);
  console.log(`Slippage bps (positive=worse): avg=${avgSlip.toFixed(1)}, p50=${p50Slip.toFixed(1)}, p90=${p90Slip.toFixed(1)}`);
}

const leaderByToken = new Map();
for (const l of leader) leaderByToken.set(l.tokenId, (leaderByToken.get(l.tokenId) ?? 0) + 1);
const followerByToken = new Map();
for (const f of follower) followerByToken.set(f.tokenId, (followerByToken.get(f.tokenId) ?? 0) + 1);

const missedTop = [];
for (const [tokenId, c] of leaderByToken.entries()) {
  if (!followerByToken.has(tokenId)) missedTop.push({ tokenId, count: c });
}
missedTop.sort((a, b) => b.count - a.count);

console.log(`\nTop leader tokens never copied in window:`);
for (const m of missedTop.slice(0, 10)) {
  console.log(`token=${m.tokenId.slice(0, 20)}... leaderTrades=${m.count}`);
}
