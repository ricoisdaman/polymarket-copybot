"""Quick summary: overlap, sport mix and slippage — skips the slow market-by-market loop"""
import sqlite3, json
from datetime import datetime, timezone
from collections import defaultdict

DB = 'packages/db/prisma/dev.db'
db = sqlite3.connect(DB)
db.row_factory = sqlite3.Row

now_ms = int(datetime.now(timezone.utc).timestamp() * 1000)
since_30d = now_ms - 30 * 24 * 3600 * 1000

def sport(slug):
    if not slug: return 'other'
    s = str(slug).lower()
    for p, label in [('atp-','tennis'),('wta-','tennis'),('tennis-','tennis'),
                     ('mlb-','mlb'),('nhl-','nhl'),('nba-','nba'),('nfl-','nfl'),
                     ('ncaa-','ncaa'),('cbb-','ncaa'),('ufc-','ufc'),
                     ('epl-','soccer'),('mls-','soccer'),('ucl-','soccer')]:
        if s.startswith(p): return label
    return 'other'

# ── Sport mix comparison (from fills) ─────────────────────────────
print("=== FILLS BY SPORT: live vs paper-v2 (all-time) ===\n")
for pid in ['live', 'paper-v2']:
    rows = db.execute("""
        SELECT json_extract(le.rawJson,'$.slug') as slug,
               ci.side, COUNT(*) as cnt, SUM(f.price*f.size) as notional
        FROM Fill f
        JOIN "Order" o ON o.id=f.orderId
        JOIN CopyIntent ci ON ci.id=o.intentId
        LEFT JOIN LeaderEvent le ON le.id=ci.leaderEventId
        WHERE f.profileId=? AND ci.side='BUY'
        GROUP BY json_extract(le.rawJson,'$.slug')
    """, (pid,)).fetchall()
    st = defaultdict(lambda: {'fills': 0, 'notional': 0.0})
    for r in rows:
        s = sport(r['slug'])
        st[s]['fills'] += r['cnt']
        st[s]['notional'] += r['notional'] or 0
    print(f"  {pid}:")
    for s, d in sorted(st.items(), key=lambda x: x[1]['fills'], reverse=True):
        print(f"    {s:<12}  fills={d['fills']:4d}  notional=${d['notional']:.2f}")
    print()

# ── Slug overlap ───────────────────────────────────────────────────
print("=== SLUG OVERLAP (last 30d) ===\n")
def get_slugs(pid):
    rows = db.execute("""
        SELECT DISTINCT json_extract(le.rawJson,'$.slug') as slug
        FROM Fill f
        JOIN "Order" o ON o.id=f.orderId
        JOIN CopyIntent ci ON ci.id=o.intentId
        JOIN LeaderEvent le ON le.id=ci.leaderEventId
        WHERE f.profileId=? AND ci.ts > ? AND ci.side='BUY'
    """, (pid, since_30d)).fetchall()
    return {r['slug'] for r in rows if r['slug']}

live_s = get_slugs('live')
paper_s = get_slugs('paper-v2')
overlap = live_s & paper_s
live_only = live_s - paper_s
paper_only = paper_s - live_s

print(f"  Live slugs filled:       {len(live_s)}")
print(f"  Paper-v2 slugs filled:   {len(paper_s)}")
print(f"  OVERLAP (both filled):   {len(overlap)}")
print(f"  Live-only slugs:         {len(live_only)}")
print(f"  Paper-v2-ONLY slugs:     {len(paper_only)}")
print()
print("  Overlap slugs:")
for s in sorted(overlap):
    print(f"    {sport(s):<10}  {s}")
print()
print("  Live-only:")
for s in sorted(live_only):
    print(f"    {sport(s):<10}  {s}")

# ── Slippage ───────────────────────────────────────────────────────
print("\n=== LIVE SLIPPAGE SUMMARY ===\n")
rows = db.execute("""
    SELECT f.price as fp, le.price as lp, f.size,
           json_extract(le.rawJson,'$.slug') as slug
    FROM Fill f
    JOIN "Order" o ON o.id=f.orderId
    JOIN CopyIntent ci ON ci.id=o.intentId
    JOIN LeaderEvent le ON le.id=ci.leaderEventId
    WHERE f.profileId='live'
""").fetchall()
if rows:
    total_extra = sum((r['fp']-r['lp'])*r['size'] for r in rows)
    avg_bps = sum((r['fp']-r['lp'])/max(r['lp'],0.001)*10000 for r in rows)/len(rows)
    by_sport = defaultdict(lambda: {'cnt':0,'extra':0.0})
    for r in rows:
        s = sport(r['slug'])
        by_sport[s]['cnt'] += 1
        by_sport[s]['extra'] += (r['fp']-r['lp'])*r['size']
    print(f"  Fills: {len(rows)}")
    print(f"  Total extra cost vs leader: ${total_extra:+.4f}")
    print(f"  Average slippage: {avg_bps:+.1f} bps  ({avg_bps/100:+.2f}%)")
    print()
    for s, d in sorted(by_sport.items(), key=lambda x: x[1]['cnt'], reverse=True):
        avg_s = d['extra']/d['cnt']
        print(f"    {s:<12}  fills={d['cnt']:3d}  total_extra=${d['extra']:+.4f}  avg_extra/fill=${avg_s:+.4f}")

# ── Summary stats ──────────────────────────────────────────────────
print("\n=== SUMMARY TABLE ===\n")

STARTING = {'live': 60, 'paper-v2': 100}

for pid in ['live', 'paper-v2']:
    cash = db.execute("SELECT value FROM RuntimeMetric WHERE profileId=? AND key='bot.cash_usdc'", (pid,)).fetchone()
    drawdown = db.execute("SELECT value FROM RuntimeMetric WHERE profileId=? AND key='bot.drawdown_usdc'", (pid,)).fetchone()
    fills = db.execute("SELECT COUNT(*) as c FROM Fill f JOIN \"Order\" o ON o.id=f.orderId JOIN CopyIntent ci ON ci.id=o.intentId WHERE f.profileId=? AND ci.side='BUY'", (pid,)).fetchone()
    geo = db.execute("SELECT COUNT(*) as c FROM CopyIntent WHERE profileId=? AND reason='GEO_RESTRICTED'", (pid,)).fetchone()
    live_not_fill = db.execute("SELECT COUNT(*) as c FROM CopyIntent WHERE profileId=? AND reason='LIVE_ORDER_NOT_FILLED'", (pid,)).fetchone()
    
    cash_v = float(cash['value']) if cash else 0
    pos_cost = STARTING[pid] - cash_v - float(drawdown['value'] if drawdown else 0)
    
    print(f"  {pid}:")
    print(f"    Cash:              ${cash_v:.2f}")
    print(f"    Drawdown (live):   ${float(drawdown['value']) if drawdown else 0:.2f}")
    print(f"    BUY fills:         {fills['c'] if fills else 0}")
    print(f"    GEO_RESTRICTED:    {geo['c'] if geo else 0}  ← orders attempted but blocked by Polymarket")
    print(f"    Missed (no fill):  {live_not_fill['c'] if live_not_fill else 0}")
    print()
