// STEP 5: Leader sizing vs our sizing
// leaderSize is stored in CopyIntent — compare to desiredNotional
// For paper-v2 we also have win/loss outcomes to see if bigger leader bets = better win rate
import path from 'path';
import { fileURLToPath } from 'url';
import { PrismaClient } from './packages/db/node_modules/@prisma/client/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbUrl = 'file:' + path.resolve(__dirname, './packages/db/prisma/dev.db').replace(/\\/g, '/');
const db = new PrismaClient({ datasources: { db: { url: dbUrl } } });

async function main() {
  // Get filled intents for both profiles with leaderSize
  const profiles = ['live', 'paper-v2'];

  for (const profileId of profiles) {
    const intents = await db.copyIntent.findMany({
      where: { profileId, status: { in: ['FILLED', 'SETTLED'] } },
      select: { id: true, tokenId: true, leaderSize: true, desiredNotional: true, leaderEventId: true }
    });

    // For paper-v2 compute P&L per token
    const pnlByToken = {};
    if (profileId === 'paper-v2') {
      const fills = await db.fill.findMany({ where: { profileId }, select: { orderId: true, price: true, size: true } });
      const orders = await db.order.findMany({ where: { profileId }, select: { id: true, intentId: true } });
      const allIntents = await db.copyIntent.findMany({ where: { profileId }, select: { id: true, tokenId: true, side: true } });
      const orderMap = new Map(orders.map(o => [o.id, o.intentId]));
      const intentMap = new Map(allIntents.map(i => [i.id, i]));
      const byToken = {};
      for (const f of fills) {
        const iid = orderMap.get(f.orderId);
        const intent = iid ? intentMap.get(iid) : null;
        if (!intent) continue;
        const t = intent.tokenId;
        if (!byToken[t]) byToken[t] = { buyCost: 0, buyShares: 0, sellRev: 0, sellShares: 0 };
        if (intent.side === 'BUY') { byToken[t].buyCost += f.price * f.size; byToken[t].buyShares += f.size; }
        else { byToken[t].sellRev += f.price * f.size; byToken[t].sellShares += f.size; }
      }
      for (const [t, d] of Object.entries(byToken)) {
        if (d.buyShares === 0 || d.sellShares === 0) continue;
        const avgBuy = d.buyCost / d.buyShares;
        const avgSell = d.sellRev / d.sellShares;
        pnlByToken[t] = (avgSell - avgBuy) * Math.min(d.buyShares, d.sellShares);
      }
    }

    // Leader size buckets (USDC)
    const buckets = {
      'tiny  (<$5)':    { min: 0,   max: 5,    trades: 0, wins: 0, losses: 0, pnl: 0 },
      'small ($5-15)':  { min: 5,   max: 15,   trades: 0, wins: 0, losses: 0, pnl: 0 },
      'med   ($15-50)': { min: 15,  max: 50,   trades: 0, wins: 0, losses: 0, pnl: 0 },
      'large ($50-150)':{ min: 50,  max: 150,  trades: 0, wins: 0, losses: 0, pnl: 0 },
      'huge  ($150+)':  { min: 150, max: 99999,trades: 0, wins: 0, losses: 0, pnl: 0 },
    };

    const leaderSizes = [];
    let zeroSizeCount = 0;

    for (const intent of intents) {
      const ls = intent.leaderSize ?? 0;
      if (ls === 0) { zeroSizeCount++; continue; }
      leaderSizes.push(ls);

      for (const [, b] of Object.entries(buckets)) {
        if (ls >= b.min && ls < b.max) {
          b.trades++;
          const pnl = pnlByToken[intent.tokenId] ?? null;
          if (pnl !== null) {
            if (pnl > 0) b.wins++; else b.losses++;
            b.pnl += pnl;
          }
          break;
        }
      }
    }

    // Stats
    leaderSizes.sort((a, b) => a - b);
    const avg = leaderSizes.reduce((s, v) => s + v, 0) / leaderSizes.length;
    const med = leaderSizes[Math.floor(leaderSizes.length / 2)];
    const max = leaderSizes[leaderSizes.length - 1];
    const min = leaderSizes[0];

    console.log(`\n===== STEP 5: ${profileId.toUpperCase()} — LEADER SIZE vs OUR SIZE =====`);
    console.log(`  Our fixed size: $3 per trade`);
    console.log(`  Leader size stats: min=$${min?.toFixed(2)} | avg=$${avg?.toFixed(2)} | median=$${med?.toFixed(2)} | max=$${max?.toFixed(2)}`);
    console.log(`  Intents with leaderSize=0 (not captured): ${zeroSizeCount}`);

    const hasPnl = profileId === 'paper-v2';
    console.log(`\n  Leader Size Bucket | Trades | ${hasPnl ? 'Win% | PnL' : ''}`);
    console.log(`  -------------------|--------|${hasPnl ? '-----|-------' : ''}`);
    for (const [label, b] of Object.entries(buckets)) {
      if (b.trades === 0) continue;
      const wl = b.wins + b.losses;
      const winPct = wl > 0 ? ((b.wins / wl) * 100).toFixed(0) + '%' : 'n/a';
      const pnlStr = hasPnl ? ` | $${b.pnl.toFixed(2).padStart(7)}` : '';
      console.log(`  ${label}  |   ${String(b.trades).padStart(3)}  | ${hasPnl ? winPct.padStart(4) + pnlStr : ''}`);
    }

    // Ratio: our size vs leader size
    const ratios = intents
      .filter(i => (i.leaderSize ?? 0) > 0)
      .map(i => ({ ratio: i.desiredNotional / i.leaderSize, leaderSize: i.leaderSize, ourSize: i.desiredNotional }));
    const avgRatio = ratios.reduce((s, r) => s + r.ratio, 0) / ratios.length;
    console.log(`\n  Avg ratio (our $3 / leader size): ${(avgRatio * 100).toFixed(1)}% of leader's bet`);
    console.log(`  e.g. when leader bets $${med?.toFixed(0)}, we bet $3 = ${(3 / (med ?? 1) * 100).toFixed(1)}% of their stake`);
    console.log(`  When leader bets tiny (<$5): we match or exceed their stake — no Kelly advantage`);

    // Extra: distribution of leader bets by size range
    const dist = { '<5': 0, '5-15': 0, '15-50': 0, '50-150': 0, '150+': 0 };
    for (const s of leaderSizes) {
      if (s < 5) dist['<5']++;
      else if (s < 15) dist['5-15']++;
      else if (s < 50) dist['15-50']++;
      else if (s < 150) dist['50-150']++;
      else dist['150+']++;
    }
    console.log(`\n  Leader bet distribution:`);
    for (const [range, count] of Object.entries(dist)) {
      const pct = ((count / leaderSizes.length) * 100).toFixed(1);
      console.log(`    $${range}: ${count} trades (${pct}%)`);
    }
  }
}

main().catch(e => console.error(e.message)).finally(() => db.$disconnect());
