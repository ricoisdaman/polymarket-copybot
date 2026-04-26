// Compare pre-fix vs post-fix trading using paper-v2 as the benchmark
// Pre-fix: min price 0.60 (approx April 4-12)
// Post-fix: min price 0.70 (April 13+)
import { PrismaClient } from './packages/db/node_modules/@prisma/client/index.js';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbUrl = 'file:' + path.resolve(__dirname, './packages/db/prisma/dev.db').replace(/\\/g, '/');
const db = new PrismaClient({ datasources: { db: { url: dbUrl } } });

// ── Paper-v2: breakdown of resolved trades by price band and sport (post-fix context)
const fills = await db.$queryRawUnsafe(`
  SELECT ci.tokenId, ci.side, f.price, f.size, f.ts, le.rawJson
  FROM Fill f
  JOIN "Order" o ON f.orderId = o.id
  JOIN CopyIntent ci ON o.intentId = ci.id
  LEFT JOIN LeaderEvent le ON ci.leaderEventId = le.id
  WHERE ci.profileId = 'paper-v2'
  ORDER BY f.ts ASC
`);

// Build per-token buy/sell
const byToken = {};
for (const r of fills) {
  let rj = {}; try { rj = JSON.parse(r.rawJson || '{}'); } catch {}
  const slug = (rj.slug || '').toLowerCase();
  const isTennis = slug.startsWith('atp-') || slug.startsWith('wta-') || slug.startsWith('tennis-');
  if (!byToken[r.tokenId]) byToken[r.tokenId] = { slug, isTennis, bc: 0, bs: 0, sc: 0, ss: 0 };
  const n = Number(r.price) * Number(r.size);
  if (r.side === 'BUY') { byToken[r.tokenId].bc += n; byToken[r.tokenId].bs += Number(r.size); }
  else { byToken[r.tokenId].sc += n; byToken[r.tokenId].ss += Number(r.size); }
}

// Resolved trades (have both buy and sell)
const resolved = [];
for (const [tid, t] of Object.entries(byToken)) {
  if (t.bs === 0 || t.ss === 0) continue;
  const avgBuy = t.bc / t.bs;
  const pnl = t.sc - t.bc;
  const won = pnl > 0;
  resolved.push({ ...t, avgBuy, pnl, won });
}

function band(p) {
  if (p < 0.65) return '0.60-0.65';
  if (p < 0.70) return '0.65-0.70';
  if (p < 0.75) return '0.70-0.75';
  if (p < 0.80) return '0.75-0.80';
  if (p < 0.85) return '0.80-0.85';
  if (p < 0.90) return '0.85-0.90';
  return '0.90+';
}

// Band stats separated by tennis vs non-tennis
const stats = {};
for (const t of resolved) {
  const b = band(t.avgBuy);
  const key = `${b}|${t.isTennis ? 'TENNIS' : 'OTHER'}`;
  if (!stats[key]) stats[key] = { wins: 0, losses: 0, pnl: 0 };
  if (t.won) stats[key].wins++; else stats[key].losses++;
  stats[key].pnl += t.pnl;
}

console.log('=== Paper-V2: Price Band × Sport Type (resolved trades) ===\n');
console.log('  Band        | Type   | Trades | Win% | P&L');
console.log('  ------------|--------|--------|------|-------');
const bandOrder = ['0.60-0.65','0.65-0.70','0.70-0.75','0.75-0.80','0.80-0.85','0.85-0.90','0.90+'];
for (const b of bandOrder) {
  for (const type of ['OTHER', 'TENNIS']) {
    const s = stats[`${b}|${type}`];
    if (!s) continue;
    const total = s.wins + s.losses;
    const winPct = ((s.wins / total) * 100).toFixed(0) + '%';
    console.log(`  ${b}  | ${type.padEnd(6)} |   ${String(total).padStart(3)}  | ${winPct.padStart(4)} | $${s.pnl.toFixed(2)}`);
  }
}

// Daily trade count for live bot (to show volume issue)
const liveFills = await db.$queryRawUnsafe(`
  SELECT DATE(f.ts/1000, 'unixepoch') as day, COUNT(DISTINCT ci.tokenId) as trades, 
    SUM(f.price * f.size) as notional,
    SUM(CASE WHEN le.rawJson LIKE '%"slug":"atp-%' OR le.rawJson LIKE '%"slug":"wta-%' THEN 1 ELSE 0 END) as tennisTrades
  FROM Fill f
  JOIN "Order" o ON f.orderId = o.id
  JOIN CopyIntent ci ON o.intentId = ci.id
  LEFT JOIN LeaderEvent le ON ci.leaderEventId = le.id
  WHERE ci.profileId = 'live' AND ci.side = 'BUY'
  GROUP BY day
  ORDER BY day ASC
`);
console.log('\n=== LIVE BOT: Trades per day (with tennis count) ===\n');
console.log('  Date       | Trades | Notional | Tennis');
console.log('  -----------|--------|----------|-------');
for (const r of liveFills) {
  const flag = r.day >= '2026-04-13' ? ' ← post-fix' : (r.day >= '2026-04-04' ? ' ← BAD PERIOD' : '');
  console.log(`  ${r.day} |   ${String(r.trades).padStart(3)}  | $${Number(r.notional).toFixed(2).padStart(7)} | ${r.tennisTrades} tennis${flag}`);
}

// Today's metric snapshot
const metrics = await db.runtimeMetric.findMany({
  where: { profileId: 'live', key: { in: ['bot.cash_usdc', 'bot.drawdown_usdc', 'bot.live_starting_usdc'] } }
});
console.log('\n=== CURRENT LIVE BOT STATE ===');
for (const m of metrics) console.log(`  ${m.key}: ${m.value}`);
console.log('  Cumulative loss from $60 start: $' + (60 - Number(metrics.find(m => m.key === 'bot.cash_usdc')?.value || 60)).toFixed(2));

await db.$disconnect();
