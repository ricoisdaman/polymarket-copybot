// Does high volume cause losses, or does the wrong price filter cause losses?
// Compare paper-v2 (no cap, correct 0.70 filter) daily trade count vs daily P&L
import { PrismaClient } from './packages/db/node_modules/@prisma/client/index.js';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbUrl = 'file:' + path.resolve(__dirname, './packages/db/prisma/dev.db').replace(/\\/g, '/');
const db = new PrismaClient({ datasources: { db: { url: dbUrl } } });

// Get paper-v2 resolved trades with their buy date
const rows = await db.$queryRawUnsafe(`
  SELECT ci.tokenId, ci.side, f.price, f.size, f.ts
  FROM Fill f
  JOIN "Order" o ON f.orderId = o.id
  JOIN CopyIntent ci ON o.intentId = ci.id
  WHERE ci.profileId = 'paper-v2'
  ORDER BY f.ts ASC
`);

const byToken = {};
for (const r of rows) {
  if (!byToken[r.tokenId]) byToken[r.tokenId] = { bc: 0, bs: 0, sc: 0, ss: 0, buyDay: null };
  const n = Number(r.price) * Number(r.size);
  if (r.side === 'BUY') {
    byToken[r.tokenId].bc += n;
    byToken[r.tokenId].bs += Number(r.size);
    const day = new Date(Number(r.ts)).toISOString().slice(0, 10);
    if (!byToken[r.tokenId].buyDay) byToken[r.tokenId].buyDay = day;
  } else {
    byToken[r.tokenId].sc += n;
    byToken[r.tokenId].ss += Number(r.size);
  }
}

// Build daily stats for paper-v2
const byDay = {};
for (const [, t] of Object.entries(byToken)) {
  if (t.bs === 0 || t.ss === 0 || !t.buyDay) continue;
  const pnl = t.sc - t.bc;
  const won = pnl > 0;
  if (!byDay[t.buyDay]) byDay[t.buyDay] = { trades: 0, notional: 0, wins: 0, losses: 0, pnl: 0 };
  byDay[t.buyDay].trades++;
  byDay[t.buyDay].notional += t.bc;
  if (won) byDay[t.buyDay].wins++; else byDay[t.buyDay].losses++;
  byDay[t.buyDay].pnl += pnl;
}

console.log('=== PAPER-V2: Daily resolved trades + P&L (no daily cap, 0.60-0.88 filter) ===\n');
console.log('  Date       | Trades | Notional  | Win% | P&L     |');
console.log('  -----------|--------|-----------|------|---------|');
let totalPnl = 0;
for (const [day, d] of Object.entries(byDay).sort()) {
  const winPct = ((d.wins / d.trades) * 100).toFixed(0) + '%';
  const pnlFlag = d.pnl > 0 ? '✓' : '✗';
  totalPnl += d.pnl;
  console.log(`  ${day} |   ${String(d.trades).padStart(3)}  | $${Number(d.notional).toFixed(2).padStart(8)} | ${winPct.padStart(4)} | $${d.pnl.toFixed(2).padStart(6)} | ${pnlFlag}`);
}
console.log(`\n  Total P&L: $${totalPnl.toFixed(2)}`);

// EV calc: at 0.70+ filter, what is expected value per trade?
const v2Fills = await db.$queryRawUnsafe(`
  SELECT ci.tokenId, ci.side, f.price, f.size
  FROM Fill f
  JOIN "Order" o ON f.orderId = o.id
  JOIN CopyIntent ci ON o.intentId = ci.id
  WHERE ci.profileId = 'paper-v2'
`);
const v2ByToken = {};
for (const r of v2Fills) {
  if (!v2ByToken[r.tokenId]) v2ByToken[r.tokenId] = { bc: 0, bs: 0, sc: 0, ss: 0 };
  const n = Number(r.price) * Number(r.size);
  if (r.side === 'BUY') { v2ByToken[r.tokenId].bc += n; v2ByToken[r.tokenId].bs += Number(r.size); }
  else { v2ByToken[r.tokenId].sc += n; v2ByToken[r.tokenId].ss += Number(r.size); }
}

let totalTrades = 0, positivePnl = 0;
let aboveFilter = 0, aboveFilterPnl = 0;
for (const [, t] of Object.entries(v2ByToken)) {
  if (t.bs === 0 || t.ss === 0) continue;
  const avgBuy = t.bc / t.bs;
  const pnl = t.sc - t.bc;
  totalTrades++;
  if (pnl > 0) positivePnl++;
  if (avgBuy >= 0.70) {
    aboveFilter++;
    aboveFilterPnl += pnl;
  }
}

console.log(`\n=== EV at 0.70+ filter (paper-v2 resolved) ===`);
console.log(`  Trades at 0.70+: ${aboveFilter}`);
console.log(`  Total P&L at 0.70+: $${aboveFilterPnl.toFixed(2)}`);
console.log(`  Avg P&L per trade: $${(aboveFilterPnl / aboveFilter).toFixed(3)}`);
console.log(`  At $3/trade avg notional: ROI = ${((aboveFilterPnl / aboveFilter) / 3 * 100).toFixed(1)}% per trade`);

await db.$disconnect();
