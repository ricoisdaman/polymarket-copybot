// STEP 3: Market type & sports breakdown
// Extract sport and market type from market titles stored in LeaderEvent.rawJson
// for both live and paper-v2 profiles.
import path from 'path';
import { fileURLToPath } from 'url';
import { PrismaClient } from './packages/db/node_modules/@prisma/client/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbUrl = 'file:' + path.resolve(__dirname, './packages/db/prisma/dev.db').replace(/\\/g, '/');
const db = new PrismaClient({ datasources: { db: { url: dbUrl } } });

function classifySport(title) {
  const t = title.toLowerCase();
  if (t.includes('nba') || t.includes('basketball') || (t.includes('lakers') || t.includes('celtics') || t.includes('warriors') || t.includes('knicks') || t.includes('bulls') || t.includes('heat') || t.includes('nets') || t.includes('bucks') || t.includes('suns') || t.includes('mavs') || t.includes('nuggets') || t.includes('clippers') || t.includes('spurs') || t.includes('pistons') || t.includes('hawks') || t.includes('wizards') || t.includes('grizzlies') || t.includes('thunder') || t.includes('pacers') || t.includes('jazz') || t.includes('kings') || t.includes('trail blazers') || t.includes('timberwolves') || t.includes('pelicans') || t.includes('hornets') || t.includes('raptors') || t.includes('magic'))) return 'NBA/Basketball';
  if (t.includes('nfl') || t.includes('american football') || (t.includes('chiefs') || t.includes('eagles') || t.includes('cowboys') || t.includes('patriots') || t.includes('49ers') || t.includes('packers') || t.includes('steelers') || t.includes('ravens') || t.includes('dolphins') || t.includes('bills'))) return 'NFL/American Football';
  if (t.includes('nhl') || t.includes('hockey') || t.includes('stanley cup')) return 'NHL/Hockey';
  if (t.includes('mlb') || t.includes('baseball') || t.includes('world series') || t.includes('yankees') || t.includes('dodgers') || t.includes('red sox') || t.includes('cubs') || t.includes('mets') || t.includes('astros')) return 'MLB/Baseball';
  if (t.includes('soccer') || t.includes('football') || t.includes('premier league') || t.includes('champions league') || t.includes('la liga') || t.includes('bundesliga') || t.includes('serie a') || t.includes('mls') || t.includes('copa') || t.includes('euro') || t.includes('fifa') || t.includes('world cup') || t.includes('fc ') || t.includes(' fc') || t.includes(' cf ') || t.includes('arsenal') || t.includes('chelsea') || t.includes('liverpool') || t.includes('manchester') || t.includes('real madrid') || t.includes('barcelona') || t.includes('juventus') || t.includes('psg') || t.includes('atletico') || t.includes('ajax') || t.includes('porto') || t.includes('sevilla') || t.includes('napoli') || t.includes('milan') || t.includes('inter') || t.includes('roma') || t.includes('lazio') || t.includes('celtic') || t.includes('rangers') || t.includes('dortmund') || t.includes('bayern') || t.includes('leverkusen') || t.includes('united') || t.includes('city') || t.includes('tottenham') || t.includes('villa') || t.includes('newcastle') || t.includes('west ham') || t.includes('brighton') || t.includes('brentford') || t.includes(' spurs') || t.includes('wolves') || t.includes('leicester') || t.includes('everton') || t.includes('southampton') || t.includes('crystal pal') || t.includes('fulham') || t.includes('ipswich') || t.includes('boro') || t.includes('leeds') || t.includes('sheffield')) return 'Soccer/Football';
  if (t.includes('tennis') || t.includes('wimbledon') || t.includes('us open') || t.includes('french open') || t.includes('australian open') || t.includes('grand slam') || t.includes('atp') || t.includes('wta') || t.includes('djokovic') || t.includes('federer') || t.includes('nadal') || t.includes('alcaraz') || t.includes('sinner') || t.includes('medvedev') || t.includes('swiatek') || t.includes('sabalenka')) return 'Tennis';
  if (t.includes('ufc') || t.includes('mma') || t.includes('boxing') || t.includes('fight') || t.includes('knockout') || t.includes('bout')) return 'MMA/Boxing/UFC';
  if (t.includes('golf') || t.includes('masters') || t.includes('pga') || t.includes('open championship') || t.includes('ryder cup') || t.includes('mcilroy') || t.includes('scheffler') || t.includes('woods')) return 'Golf';
  if (t.includes('nascar') || t.includes('formula 1') || t.includes('f1') || t.includes('motogp') || t.includes('racing') || t.includes('grand prix') || t.includes('verstappen') || t.includes('hamilton') || t.includes('indycar')) return 'Motor Racing';
  if (t.includes('esports') || t.includes('cs2') || t.includes('csgo') || t.includes('dota') || t.includes('league of legends') || t.includes('valorant') || t.includes('overwatch') || t.includes('rocket league') || t.includes('fortnite') || t.includes('navi') || t.includes('faze') || t.includes('teamliquid') || t.includes('g2 ') || t.includes('t1 ') || t.includes('cloud9') || t.includes('fnatic') || t.includes('vitality')) return 'Esports';
  if (t.includes('cricket') || t.includes('ipl') || t.includes('test match') || t.includes('odi ') || t.includes('t20')) return 'Cricket';
  if (t.includes('rugby') || t.includes('six nations') || t.includes('super rugby') || t.includes('ruck')) return 'Rugby';
  return 'Other/Unknown';
}

function classifyMarketType(title) {
  const t = title.toLowerCase();
  if (t.includes('win') || t.includes('winner') || t.includes('to win') || t.includes('will win') || t.includes('beat') || t.includes('defeats') || t.includes('match winner') || t.includes('advance') || t.includes('qualify') || t.includes('champion')) return 'Match Winner';
  if (t.includes('total') || t.includes('over') || t.includes('under') || t.includes('o/u') || t.includes('ou ') || t.includes('points') || t.includes('goals') || t.includes('score') || t.includes('more than') || t.includes('fewer than') || t.includes('at least')) return 'Totals/Over-Under';
  if (t.includes('spread') || t.includes('handicap') || t.includes('cover') || t.includes('+1') || t.includes('-1') || t.includes('+2') || t.includes('-2') || t.includes('+3') || t.includes('-3') || t.includes('+4') || t.includes('-4') || t.includes('+5') || t.includes('-5') || t.includes('+6') || t.includes('-6') || t.includes('+7') || t.includes('-7')) return 'Spread/Handicap';
  if (t.includes('player') || t.includes('top scorer') || t.includes('first scorer') || t.includes('anytime scorer') || t.includes('mvp') || t.includes('most points') || t.includes('top assists') || t.includes('trump') || t.includes('named player')) return 'Player Prop';
  if (t.includes('both teams') || t.includes('btts') || t.includes('clean sheet') || t.includes('any team')) return 'Both Teams Score';
  if (t.includes('half') || t.includes('1st half') || t.includes('2nd half') || t.includes('first half') || t.includes('second half') || t.includes('quarter') || t.includes('1q') || t.includes('2q') || t.includes('3q') || t.includes('4q')) return 'Half/Quarter';
  if (t.includes('draw') || t.includes('tie') || t.includes('1x2')) return 'Draw/Tie';
  return 'Other';
}

async function analyseProfile(profileId) {
  // Get filled intents with their market titles from linked leader events
  const intents = await db.copyIntent.findMany({
    where: { profileId, status: { in: ['FILLED', 'SETTLED'] } },
    select: { id: true, tokenId: true, leaderEventId: true }
  });

  const leaderEventIds = intents.map(i => i.leaderEventId).filter(Boolean);
  const leaderEvents = await db.leaderEvent.findMany({
    where: { id: { in: leaderEventIds } },
    select: { id: true, tokenId: true, rawJson: true }
  });
  const titleByLeaderEventId = new Map();
  for (const ev of leaderEvents) {
    try {
      const parsed = JSON.parse(ev.rawJson);
      const title = parsed.title || parsed.question || parsed.market_slug || '';
      titleByLeaderEventId.set(ev.id, title.trim());
    } catch { titleByLeaderEventId.set(ev.id, ''); }
  }

  // For paper-v2, get P&L per token
  const fills = await db.fill.findMany({ where: { profileId }, select: { orderId: true, price: true, size: true } });
  const orders = await db.order.findMany({ where: { profileId }, select: { id: true, intentId: true } });
  const allIntents = await db.copyIntent.findMany({ where: { profileId }, select: { id: true, tokenId: true, side: true } });
  const orderMap = new Map(orders.map(o => [o.id, o.intentId]));
  const intentMap = new Map(allIntents.map(i => [i.id, i]));

  const pnlByToken = {};
  if (profileId === 'paper-v2') {
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
      const closeSize = Math.min(d.buyShares, d.sellShares);
      pnlByToken[t] = (avgSell - avgBuy) * closeSize;
    }
  }

  // Build sport/type stats
  const sportStats = {};
  const typeStats = {};
  const unknownTitles = [];

  for (const intent of intents) {
    const title = titleByLeaderEventId.get(intent.leaderEventId) || '';
    const sport = classifySport(title);
    const mtype = classifyMarketType(title);
    const pnl = pnlByToken[intent.tokenId] ?? null;
    const win = pnl !== null ? pnl > 0 : null;

    if (!sportStats[sport]) sportStats[sport] = { count: 0, wins: 0, losses: 0, pnl: 0 };
    sportStats[sport].count++;
    if (win !== null) { if (win) sportStats[sport].wins++; else sportStats[sport].losses++; }
    if (pnl !== null) sportStats[sport].pnl += pnl;

    if (!typeStats[mtype]) typeStats[mtype] = { count: 0, wins: 0, losses: 0, pnl: 0 };
    typeStats[mtype].count++;
    if (win !== null) { if (win) typeStats[mtype].wins++; else typeStats[mtype].losses++; }
    if (pnl !== null) typeStats[mtype].pnl += pnl;

    if (sport === 'Other/Unknown' && title) unknownTitles.push(title);
  }

  const hasPnl = profileId === 'paper-v2';
  console.log(`\n===== STEP 3: ${profileId.toUpperCase()} — SPORT BREAKDOWN =====`);
  console.log(`  Sport              | Trades | ${hasPnl ? 'Win%  | PnL' : 'Count'}`);
  console.log(`  -------------------|--------|${hasPnl ? '------|-------' : '------'}`);
  for (const [sport, s] of Object.entries(sportStats).sort((a, b) => b[1].count - a[1].count)) {
    const hasWL = s.wins + s.losses > 0;
    const winPct = hasWL ? ((s.wins / (s.wins + s.losses)) * 100).toFixed(0) + '%' : 'n/a';
    const pnlStr = hasPnl ? `$${s.pnl.toFixed(2).padStart(7)}` : '';
    console.log(`  ${sport.padEnd(18)} |   ${String(s.count).padStart(3)}  | ${hasPnl ? winPct.padStart(4) + ' | ' + pnlStr : ''}`);
  }

  console.log(`\n── ${profileId.toUpperCase()} — MARKET TYPE BREAKDOWN ──`);
  console.log(`  Type               | Trades | ${hasPnl ? 'Win%  | PnL' : 'Count'}`);
  console.log(`  -------------------|--------|${hasPnl ? '------|-------' : '------'}`);
  for (const [mtype, s] of Object.entries(typeStats).sort((a, b) => b[1].count - a[1].count)) {
    const hasWL = s.wins + s.losses > 0;
    const winPct = hasWL ? ((s.wins / (s.wins + s.losses)) * 100).toFixed(0) + '%' : 'n/a';
    const pnlStr = hasPnl ? `$${s.pnl.toFixed(2).padStart(7)}` : '';
    console.log(`  ${mtype.padEnd(18)} |   ${String(s.count).padStart(3)}  | ${hasPnl ? winPct.padStart(4) + ' | ' + pnlStr : ''}`);
  }

  if (unknownTitles.length > 0) {
    console.log(`\n── ${profileId.toUpperCase()} — Sample Unclassified Titles (first 15) ──`);
    for (const t of [...new Set(unknownTitles)].slice(0, 15)) console.log(`  "${t}"`);
  }
}

async function main() {
  await analyseProfile('live');
  await analyseProfile('paper-v2');
}

main().catch(e => console.error(e.message)).finally(() => db.$disconnect());
