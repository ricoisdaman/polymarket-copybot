// STEP 7: Series format detection from market titles
// Also combines steps 8 (live vs pre-match) and 9 (time to resolution)
// since they all come from title parsing + fill timestamps
import path from 'path';
import { fileURLToPath } from 'url';
import { PrismaClient } from './packages/db/node_modules/@prisma/client/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbUrl = 'file:' + path.resolve(__dirname, './packages/db/prisma/dev.db').replace(/\\/g, '/');
const db = new PrismaClient({ datasources: { db: { url: dbUrl } } });

function detectSeriesFormat(title) {
  const t = title.toLowerCase();
  // Bo7, Bo5, Bo3, Bo1 (Best of X)
  if (t.includes('bo7') || t.includes('best of 7') || t.includes('best-of-7')) return 'Best-of-7';
  if (t.includes('bo5') || t.includes('best of 5') || t.includes('best-of-5')) return 'Best-of-5';
  if (t.includes('bo3') || t.includes('best of 3') || t.includes('best-of-3')) return 'Best-of-3';
  if (t.includes('bo1') || t.includes('best of 1') || t.includes('best-of-1')) return 'Best-of-1';
  // Playoff / series indicators
  if (t.includes('game 7') || t.includes('game7')) return 'Playoff Game 7';
  if (t.includes('game 6') || t.includes('game6')) return 'Playoff Game 6';
  if (t.includes('game 5') || t.includes('game5')) return 'Playoff Game 5';
  if (t.includes('game 4') || t.includes('game4')) return 'Playoff Game 4';
  if (t.includes('game 3') || t.includes('game3')) return 'Playoff Game 3';
  if (t.includes('game 2') || t.includes('game2')) return 'Playoff Game 2';
  if (t.includes('game 1') || t.includes('game1')) return 'Playoff Game 1';
  if (t.includes('series') || t.includes('playoff') || t.includes('postseason')) return 'Series/Playoffs';
  // Round indicators
  if (t.includes('final') && !t.includes('finalist') && !t.includes('semifinal')) return 'Final';
  if (t.includes('semifinal') || t.includes('semi-final')) return 'Semifinal';
  if (t.includes('quarterfinal') || t.includes('quarter-final')) return 'Quarterfinal';
  if (t.includes('round of 16') || t.includes('r16') || t.includes('last 16')) return 'Round of 16';
  if (t.includes('round 1') || t.includes('r1 ') || t.includes('round one')) return 'Round 1';
  if (t.includes('round 2') || t.includes('r2 ') || t.includes('round two')) return 'Round 2';
  if (t.includes('round 3') || t.includes('r3 ') || t.includes('round three')) return 'Round 3';
  // Tournament types
  if (t.includes('open') || t.includes('championship') || t.includes('tournament') || t.includes('cup') || t.includes('classic') || t.includes('invitational') || t.includes('masters')) return 'Tournament';
  // Regular season vs single game
  if (t.includes('vs.') || t.includes(' vs ')) return 'Regular Season Match';
  return 'Unknown';
}

function detectMatchTiming(title) {
  const t = title.toLowerCase();
  // Live / in-play indicators
  if (t.includes('live') || t.includes('in-play') || t.includes('in play') || t.includes('quarter ') || t.includes('half ') || t.includes('period ') || t.includes('inning') || t.includes('set ')) return 'In-Play/Live';
  // Time indicators suggesting in-progress
  if (t.match(/\d{1,2}(st|nd|rd|th) (quarter|period|half|set|inning)/)) return 'In-Play/Live';
  // Pre-match (most markets on polymarket are pre-match by default)
  return 'Pre-Match';
}

async function analyseProfile(profileId) {
  const intents = await db.copyIntent.findMany({
    where: { profileId, status: { in: ['FILLED', 'SETTLED'] } },
    select: { id: true, tokenId: true, leaderEventId: true, ts: true }
  });

  const leaderEventIds = intents.map(i => i.leaderEventId).filter(Boolean);
  const leEvents = await db.leaderEvent.findMany({
    where: { id: { in: leaderEventIds } },
    select: { id: true, rawJson: true, tokenId: true }
  });
  const eventById = new Map();
  for (const ev of leEvents) {
    try { eventById.set(ev.id, JSON.parse(ev.rawJson)); } catch { eventById.set(ev.id, {}); }
  }

  // Get P&L for paper-v2
  const pnlByToken = {};
  if (profileId === 'paper-v2') {
    const fills = await db.fill.findMany({ where: { profileId }, select: { orderId: true, price: true, size: true } });
    const orders = await db.order.findMany({ where: { profileId }, select: { id: true, intentId: true } });
    const allI = await db.copyIntent.findMany({ where: { profileId }, select: { id: true, tokenId: true, side: true } });
    const om = new Map(orders.map(o => [o.id, o.intentId]));
    const im = new Map(allI.map(i => [i.id, i]));
    const bt = {};
    for (const f of fills) {
      const ii = om.get(f.orderId); const intent = ii ? im.get(ii) : null;
      if (!intent) continue;
      const t = intent.tokenId;
      if (!bt[t]) bt[t] = { bc: 0, bs: 0, sc: 0, ss: 0 };
      if (intent.side === 'BUY') { bt[t].bc += f.price * f.size; bt[t].bs += f.size; }
      else { bt[t].sc += f.price * f.size; bt[t].ss += f.size; }
    }
    for (const [t, d] of Object.entries(bt)) {
      if (d.bs === 0 || d.ss === 0) continue;
      pnlByToken[t] = (d.sc / d.ss - d.bc / d.bs) * Math.min(d.bs, d.ss);
    }
  }

  // Time to resolution: for live, use position.updatedAt (when size→0) vs intent.ts
  const positions = profileId === 'live'
    ? await db.position.findMany({ where: { profileId, size: { lte: 0 } }, select: { tokenId: true, updatedAt: true } })
    : [];
  const posMap = new Map(positions.map(p => [p.tokenId, p.updatedAt]));

  // Build per-intent stats
  const seriesStats = {};
  const timingStats = {};
  const resolutionTimes = []; // hours

  for (const intent of intents) {
    const raw = eventById.get(intent.leaderEventId) || {};
    const title = raw.title || raw.question || '';
    const series = detectSeriesFormat(title);
    const timing = detectMatchTiming(title);
    const pnl = pnlByToken[intent.tokenId] ?? null;
    const win = pnl !== null ? pnl > 0 : null;

    if (!seriesStats[series]) seriesStats[series] = { count: 0, wins: 0, losses: 0, pnl: 0 };
    seriesStats[series].count++;
    if (win !== null) { if (win) seriesStats[series].wins++; else seriesStats[series].losses++; }
    if (pnl !== null) seriesStats[series].pnl += pnl;

    if (!timingStats[timing]) timingStats[timing] = { count: 0, wins: 0, losses: 0, pnl: 0 };
    timingStats[timing].count++;
    if (win !== null) { if (win) timingStats[timing].wins++; else timingStats[timing].losses++; }
    if (pnl !== null) timingStats[timing].pnl += pnl;

    // Resolution time for live
    if (profileId === 'live') {
      const resolvedAt = posMap.get(intent.tokenId);
      if (resolvedAt) {
        const hours = (new Date(resolvedAt) - new Date(intent.ts)) / 3600000;
        if (hours > 0 && hours < 720) resolutionTimes.push(hours); // ignore >30 days
      }
    }
  }

  const hasPnl = profileId === 'paper-v2';
  console.log(`\n===== STEP 7/8/9: ${profileId.toUpperCase()} — SERIES FORMAT, TIMING & RESOLUTION =====`);

  console.log(`\n── Series Format ──`);
  console.log(`  Format               | Count | ${hasPnl ? 'Win% | PnL' : ''}`);
  console.log(`  ---------------------|-------|${hasPnl ? '-----|------' : ''}`);
  for (const [fmt, s] of Object.entries(seriesStats).sort((a, b) => b[1].count - a[1].count)) {
    const wl = s.wins + s.losses;
    const wp = wl > 0 ? ((s.wins / wl) * 100).toFixed(0) + '%' : 'n/a';
    const pnlStr = hasPnl ? ` | $${s.pnl.toFixed(2).padStart(7)}` : '';
    console.log(`  ${fmt.padEnd(20)} |  ${String(s.count).padStart(4)} | ${hasPnl ? wp.padStart(4) + pnlStr : ''}`);
  }

  console.log(`\n── Match Timing (Live/In-play vs Pre-Match) ──`);
  for (const [timing, s] of Object.entries(timingStats)) {
    const wl = s.wins + s.losses;
    const wp = wl > 0 ? ((s.wins / wl) * 100).toFixed(0) + '%' : 'n/a';
    const pnlStr = hasPnl ? ` | PnL: $${s.pnl.toFixed(2)}` : '';
    console.log(`  ${timing}: ${s.count} trades | ${hasPnl ? 'Win: ' + wp + pnlStr : ''}`);
  }
  console.log(`  Note: Polymarket titles rarely include live/in-play markers — most will show as Pre-Match`);
  console.log(`  True live vs pre-match requires checking market end time vs fill time (not stored in DB)`);

  if (resolutionTimes.length > 0) {
    resolutionTimes.sort((a, b) => a - b);
    const avg = resolutionTimes.reduce((s, v) => s + v, 0) / resolutionTimes.length;
    const med = resolutionTimes[Math.floor(resolutionTimes.length / 2)];
    const under8h = resolutionTimes.filter(h => h <= 8).length;
    const under24h = resolutionTimes.filter(h => h <= 24).length;
    const under72h = resolutionTimes.filter(h => h <= 72).length;
    const over72h = resolutionTimes.filter(h => h > 72).length;
    console.log(`\n── Step 9: Time to Resolution (LIVE — fill → position zeroed) ──`);
    console.log(`  Trades with resolution data: ${resolutionTimes.length}`);
    console.log(`  Avg: ${avg.toFixed(1)}h | Median: ${med.toFixed(1)}h | Min: ${resolutionTimes[0].toFixed(1)}h | Max: ${resolutionTimes[resolutionTimes.length-1].toFixed(1)}h`);
    console.log(`  <=8h (same-day): ${under8h} (${((under8h/resolutionTimes.length)*100).toFixed(0)}%)`);
    console.log(`  <=24h: ${under24h} (${((under24h/resolutionTimes.length)*100).toFixed(0)}%)`);
    console.log(`  <=72h: ${under72h} (${((under72h/resolutionTimes.length)*100).toFixed(0)}%)`);
    console.log(`  >72h (slow): ${over72h} (${((over72h/resolutionTimes.length)*100).toFixed(0)}%)`);
  }
}

async function main() {
  await analyseProfile('live');
  await analyseProfile('paper-v2');
}

main().catch(e => console.error(e.message)).finally(() => db.$disconnect());
