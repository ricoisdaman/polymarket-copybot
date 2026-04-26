// Deep pattern analysis: outcome side (home/away), time of day, day of week
// Uses paper-v2 resolved trades (slug-based sport, sell fills for P&L)
import path from 'path';
import { fileURLToPath } from 'url';
import { PrismaClient } from './packages/db/node_modules/@prisma/client/index.js';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbUrl = 'file:' + path.resolve(__dirname, './packages/db/prisma/dev.db').replace(/\\/g,'/');
const prisma = new PrismaClient({datasources:{db:{url:dbUrl}}});

function classifySport(slug) {
  if (!slug) return 'unknown';
  const s = slug.toLowerCase();
  if (s.startsWith('mlb-')) return 'MLB';
  if (s.startsWith('nba-')) return 'NBA';
  if (s.startsWith('nhl-')) return 'NHL';
  if (s.startsWith('nfl-')) return 'NFL';
  if (s.startsWith('cbb-')) return 'NCAA';
  if (s.startsWith('atp-') || s.startsWith('wta-') || s.startsWith('tennis-')) return 'Tennis';
  return s.split('-')[0] || 'unknown';
}

// Get all paper-v2 BUY intents with full rawJson and buy fill details
const buyData = await prisma.$queryRawUnsafe(`
  SELECT 
    ci.id as intentId, ci.tokenId, ci.leaderSize, ci.ts as intentTs,
    f.price as buyPrice, f.size as buyShares,
    le.rawJson
  FROM CopyIntent ci
  JOIN LeaderEvent le ON ci.leaderEventId = le.id
  JOIN "Order" o ON o.intentId = ci.id
  JOIN Fill f ON f.orderId = o.id
  WHERE ci.profileId = 'paper-v2' AND ci.side = 'BUY'
`);

// Get SELL fills keyed by tokenId
const sellFills = await prisma.$queryRawUnsafe(`
  SELECT ci.tokenId, SUM(f.price * f.size) as sellRevenue
  FROM CopyIntent ci
  JOIN "Order" o ON o.intentId = ci.id
  JOIN Fill f ON f.orderId = o.id
  WHERE ci.profileId = 'paper-v2' AND ci.side = 'SELL'
  GROUP BY ci.tokenId
`);
const sellMap = new Map(sellFills.map(s => [s.tokenId, Number(s.sellRevenue)]));

await prisma.$disconnect();

// Build resolved trade list
const trades = new Map();
for (const r of buyData) {
  const key = r.tokenId;
  if (!trades.has(key)) {
    const rj = r.rawJson ? JSON.parse(r.rawJson) : {};
    const ts = new Date(r.intentTs);
    trades.set(key, {
      tokenId: key,
      slug: rj.slug || rj.eventSlug || '',
      title: rj.title || '',
      outcome: rj.outcome || '',
      outcomeIndex: rj.outcomeIndex,  // 0 = first team, 1 = second team
      sport: classifySport(rj.slug || rj.eventSlug || ''),
      buyPrice: 0,
      buyShares: 0,
      buyCost: 0,
      leaderSize: Number(r.leaderSize) || 0,
      hourUTC: ts.getUTCHours(),
      dayOfWeek: ts.getUTCDay(), // 0=Sun, 1=Mon...6=Sat
    });
  }
  const t = trades.get(key);
  t.buyCost += Number(r.buyPrice) * Number(r.buyShares);
  t.buyShares += Number(r.buyShares);
  t.buyPrice = t.buyCost / t.buyShares;
}

const resolved = [];
for (const [tokenId, t] of trades) {
  const rev = sellMap.get(tokenId);
  if (rev !== undefined) {
    const pnl = rev - t.buyCost;
    resolved.push({ ...t, sellRevenue: rev, pnl, won: pnl > 0 });
  }
}

console.log(`Resolved trades: ${resolved.length}\n`);

function printTable(title, grouped, sortKey = 'n') {
  console.log(`\n=== ${title} ===\n`);
  let entries = Object.entries(grouped).map(([k, v]) => {
    const n = v.wins + v.losses;
    const winPct = n > 0 ? ((v.wins/n)*100).toFixed(0)+'%' : '-';
    return { k, n, wins: v.wins, losses: v.losses, winPct, pnl: v.pnl };
  });
  if (sortKey === 'pnl') entries.sort((a,b) => b.pnl - a.pnl);
  else entries.sort((a,b) => b.n - a.n);
  console.log(`${'Key'.padEnd(16)} ${'N'.padStart(4)} ${'Wins'.padStart(5)} ${'Loss'.padStart(5)} ${'Win%'.padStart(6)} ${'P&L'.padStart(9)}`);
  console.log('-'.repeat(52));
  for (const e of entries) {
    console.log(`${e.k.padEnd(16)} ${String(e.n).padStart(4)} ${String(e.wins).padStart(5)} ${String(e.losses).padStart(5)} ${e.winPct.padStart(6)} ${('$'+e.pnl.toFixed(2)).padStart(9)}`);
  }
}

function group(arr, keyFn) {
  const m = {};
  for (const t of arr) {
    const k = keyFn(t);
    if (!m[k]) m[k] = { wins: 0, losses: 0, pnl: 0 };
    if (t.won) m[k].wins++; else m[k].losses++;
    m[k].pnl += t.pnl;
  }
  return m;
}

// 1. Home (outcomeIndex=0) vs Away (outcomeIndex=1) — for team sports
const teamSports = resolved.filter(t => ['MLB','NBA','NHL','NFL','NCAA'].includes(t.sport));
printTable('Home (0) vs Away (1) — team sports only', group(teamSports, t => {
  if (t.outcomeIndex === 0 || t.outcomeIndex === '0') return 'Home/Favourite (idx=0)';
  if (t.outcomeIndex === 1 || t.outcomeIndex === '1') return 'Away/Underdog (idx=1)';
  return `idx=${t.outcomeIndex}`;
}));

// 2. Per sport: home vs away breakdown
console.log('\n=== Home/Away win% per sport ===\n');
const SPORTS = ['MLB','NBA','NHL','Tennis'];
const HA_LABELS = ['Home/Favourite (idx=0)', 'Away/Underdog (idx=1)'];
console.log('Sport'.padEnd(10) + HA_LABELS.map(l => l.padStart(25)).join(''));
for (const sp of SPORTS) {
  let row = sp.padEnd(10);
  for (const label of HA_LABELS) {
    const subset = resolved.filter(t => t.sport === sp && (() => {
      const idx = Number(t.outcomeIndex);
      if (label.includes('0)')) return idx === 0;
      return idx === 1;
    })());
    if (subset.length === 0) { row += '                         '; continue; }
    const wins = subset.filter(t => t.won).length;
    const pct = ((wins/subset.length)*100).toFixed(0);
    const pnl = subset.reduce((s,t)=>s+t.pnl,0);
    row += `  ${pct}%(${subset.length}) $${pnl.toFixed(2)}`.padStart(25);
  }
  console.log(row);
}

// 3. Hour of day (UTC) — when the leader traded
const hourGroups = group(resolved, t => {
  const h = t.hourUTC;
  if (h >= 0 && h < 4) return '00-04 UTC';
  if (h >= 4 && h < 8) return '04-08 UTC';
  if (h >= 8 && h < 12) return '08-12 UTC';
  if (h >= 12 && h < 16) return '12-16 UTC';
  if (h >= 16 && h < 20) return '16-20 UTC';
  return '20-24 UTC';
});
printTable('Time of Day (UTC) when leader traded', hourGroups, 'pnl');

// 4. Day of week
const DOW = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
printTable('Day of Week (UTC)', group(resolved, t => DOW[t.dayOfWeek]), 'pnl');

// 5. Tennis: ATP vs WTA
const tennisData = resolved.filter(t => t.sport === 'Tennis');
printTable('Tennis: ATP vs WTA', group(tennisData, t => {
  const s = (t.slug||'').toLowerCase();
  if (s.startsWith('atp-')) return 'ATP (men)';
  if (s.startsWith('wta-')) return 'WTA (women)';
  return 'other';
}));

// 6. Leader size × sport cross tab (win% + P&L)
console.log('\n=== Leader size conviction by sport (win% / P&L) ===\n');
const sizeBands = ['<$10', '$10-30', '$30-60', '$60-100', '$100+'];
function lBand(sz) {
  const s = Number(sz);
  if (s < 10) return '<$10';
  if (s < 30) return '$10-30';
  if (s < 60) return '$30-60';
  if (s < 100) return '$60-100';
  return '$100+';
}
console.log('LeaderSz'.padEnd(10) + SPORTS.map(s => s.padStart(16)).join(''));
console.log('-'.repeat(10 + SPORTS.length * 16));
for (const lb of sizeBands) {
  let row = lb.padEnd(10);
  for (const sp of SPORTS) {
    const ss = resolved.filter(t => lBand(t.leaderSize) === lb && t.sport === sp);
    if (ss.length === 0) { row += '               -'; continue; }
    const wins = ss.filter(t => t.won).length;
    const pct = ((wins/ss.length)*100).toFixed(0);
    const pnl = ss.reduce((s,t)=>s+t.pnl,0);
    row += `  ${pct}%(${ss.length})$${pnl>=0?'+':''}${pnl.toFixed(1)}`.padStart(16);
  }
  console.log(row);
}

// 7. Outcome price × side breakdown — are faves (high price) or dogs (low price) 
//    better on home vs away?
console.log('\n=== Price band × Home/Away (win%) — all team sports ===\n');
const pBands = ['0.60-0.65','0.65-0.70','0.70-0.75','0.75-0.80','0.80-0.85','0.85-0.90','<0.60'];
function pBand(p) {
  const v = Number(p);
  if (v < 0.60) return '<0.60';
  if (v < 0.65) return '0.60-0.65';
  if (v < 0.70) return '0.65-0.70';
  if (v < 0.75) return '0.70-0.75';
  if (v < 0.80) return '0.75-0.80';
  if (v < 0.85) return '0.80-0.85';
  return '0.85-0.90';
}
const haLabels2 = ['Home(0)', 'Away(1)'];
console.log('PriceBand'.padEnd(12) + haLabels2.map(l => l.padStart(14)).join(''));
for (const pb of pBands) {
  let row = pb.padEnd(12);
  for (const haLabel of haLabels2) {
    const isHome = haLabel.includes('0)');
    const ss = teamSports.filter(t => pBand(t.buyPrice) === pb && (isHome ? Number(t.outcomeIndex) === 0 : Number(t.outcomeIndex) === 1));
    if (ss.length === 0) { row += '             -'; continue; }
    const wins = ss.filter(t => t.won).length;
    const pct = ((wins/ss.length)*100).toFixed(0);
    row += `  ${pct}%(${ss.length})`.padStart(14);
  }
  console.log(row);
}
