"""
Pre vs post SLUG_BLOCKED performance analysis.
Config version with blockedSlugs=[] switched to ['atp-','wta-','tennis-'] around April 8.
This script compares live bot performance before and after that date.
Also: analyze what the leader earned on tennis that we missed.
"""
import sqlite3, json
from datetime import datetime, timezone
from collections import defaultdict

DB = 'packages/db/prisma/dev.db'
db = sqlite3.connect(DB)
db.row_factory = sqlite3.Row

# The three config versions tell us when slug blocking was added
# active=0 createdAt=1775902308548 blockedSlugs=[]  <- BEFORE blocking
# active=0 createdAt=1775962442001 blockedSlugs=['atp-','wta-','tennis-'] <- blocking added
SLUG_BLOCK_INTRODUCED_MS = 1775962442001  # April 8, ~16:00 UTC

now_ms = int(datetime.now(timezone.utc).timestamp() * 1000)

def ms(ts):
    try: return datetime.fromtimestamp(int(ts)/1000, tz=timezone.utc).strftime('%m-%d %H:%M')
    except: return str(ts)[:16]

print("=" * 70)
print("  PRE vs POST SLUG_BLOCK ANALYSIS")
print(f"  Slug blocking introduced: {ms(SLUG_BLOCK_INTRODUCED_MS)}")
print("=" * 70)

# 1. Fill counts and notional: before vs after slug blocking
print("\n[1] ALL-TIME LIVE FILLS: before vs after slug blocking\n")
fills_before = db.execute("""
    SELECT f.price, f.size, ci.side, ci.ts,
           json_extract(le.rawJson,'$.slug') as slug
    FROM Fill f
    JOIN "Order" o ON o.id=f.orderId
    JOIN CopyIntent ci ON ci.id=o.intentId
    LEFT JOIN LeaderEvent le ON le.id=ci.leaderEventId
    WHERE f.profileId='live' AND ci.ts < ? AND ci.side='BUY'
""", (SLUG_BLOCK_INTRODUCED_MS,)).fetchall()

fills_after = db.execute("""
    SELECT f.price, f.size, ci.side, ci.ts,
           json_extract(le.rawJson,'$.slug') as slug
    FROM Fill f
    JOIN "Order" o ON o.id=f.orderId
    JOIN CopyIntent ci ON ci.id=o.intentId
    LEFT JOIN LeaderEvent le ON le.id=ci.leaderEventId
    WHERE f.profileId='live' AND ci.ts >= ? AND ci.side='BUY'
""", (SLUG_BLOCK_INTRODUCED_MS,)).fetchall()

def sport(slug):
    if not slug: return 'other'
    s = str(slug).lower()
    for p, label in [('atp-','tennis'),('wta-','tennis'),('tennis-','tennis'),
                     ('mlb-','mlb'),('nhl-','nhl'),('nba-','nba'),
                     ('nfl-','nfl'),('cbb-','ncaa'),('ncaa-','ncaa')]:
        if s.startswith(p): return label
    return 'other'

for label, fills in [('BEFORE (tennis allowed)', fills_before), ('AFTER (tennis blocked)', fills_after)]:
    notional = sum(r['price']*r['size'] for r in fills)
    by_sport = defaultdict(lambda: {'cnt':0, 'notional':0.0})
    for r in fills:
        s = sport(r['slug'])
        by_sport[s]['cnt'] += 1
        by_sport[s]['notional'] += r['price'] * r['size']
    print(f"  {label}:")
    print(f"    Total fills: {len(fills)}, Total notional: ${notional:.2f}")
    for s, d in sorted(by_sport.items(), key=lambda x: x[1]['cnt'], reverse=True):
        print(f"    {s:<12}  fills={d['cnt']:4d}  notional=${d['notional']:.2f}")
    print()

# 2. What tennis events did the leader make that we missed AFTER slug blocking?
print("\n[2] TENNIS EVENTS BLOCKED (live, since slug blocking introduced)\n")
tennis_blocked = db.execute("""
    SELECT json_extract(le.rawJson,'$.slug') as slug,
           le.price, COUNT(*) as cnt
    FROM CopyIntent ci
    JOIN LeaderEvent le ON le.id=ci.leaderEventId
    WHERE ci.profileId='live' AND ci.reason='SLUG_BLOCKED'
      AND ci.ts >= ?
    GROUP BY json_extract(le.rawJson,'$.slug')
    ORDER BY cnt DESC LIMIT 30
""", (SLUG_BLOCK_INTRODUCED_MS,)).fetchall()

total_blocked = sum(r['cnt'] for r in tennis_blocked)
print(f"  Total SLUG_BLOCKED events since block was added: {total_blocked}")
print(f"  Unique slugs blocked: {len(tennis_blocked)}")
print()
print(f"  {'slug':<50} {'avg_p':>6} {'cnt':>5}")
print("  " + "-" * 65)
for r in tennis_blocked:
    print(f"  {str(r['slug'] or ''):50s} {r['price']:>6.3f} {r['cnt']:>5}")

# 3. Check paper-sports-b which may have run WITH tennis (older profile)
print("\n[3] PAPER PROFILES WITH TENNIS ENABLED — performance check\n")
for pid in ['paper-sports-b', 'paper-v2', 'paper-v3', 'live']:
    cv = db.execute("""
        SELECT json FROM ConfigVersion WHERE profileId=? AND active=1
        ORDER BY createdAt DESC LIMIT 1
    """, (pid,)).fetchone()
    if not cv: continue
    try:
        cfg = json.loads(cv['json'])
        slugs = cfg.get('filters', {}).get('blockedSlugPrefixes', [])
        tennis_blocked_flag = any('tennis' in s or 'atp' in s or 'wta' in s for s in slugs)
    except: tennis_blocked_flag = None

    fills = db.execute("""
        SELECT COUNT(*) as cnt, SUM(f.price*f.size) as notional,
               json_extract(le.rawJson,'$.slug') as slug
        FROM Fill f
        JOIN "Order" o ON o.id=f.orderId
        JOIN CopyIntent ci ON ci.id=o.intentId
        LEFT JOIN LeaderEvent le ON le.id=ci.leaderEventId
        WHERE f.profileId=? AND ci.side='BUY'
        GROUP BY json_extract(le.rawJson,'$.slug')
    """, (pid,)).fetchall()

    total = len(fills)
    tennis_fills = sum(r['cnt'] for r in fills if sport(r['slug']) == 'tennis')
    other_fills = sum(r['cnt'] for r in fills if sport(r['slug']) != 'tennis')
    total_cnt = sum(r['cnt'] for r in fills)
    total_not = sum((r['notional'] or 0) for r in fills)

    cash = db.execute("SELECT value FROM RuntimeMetric WHERE profileId=? AND key='bot.cash_usdc'", (pid,)).fetchone()
    dd = db.execute("SELECT value FROM RuntimeMetric WHERE profileId=? AND key='bot.drawdown_usdc'", (pid,)).fetchone()
    cash_v = float(cash['value']) if cash else None
    dd_v = float(dd['value']) if dd else None

    print(f"  {pid} (tennis_blocked={tennis_blocked_flag}):")
    print(f"    Fills: {total_cnt} (tennis={tennis_fills}, other={other_fills}, unique_slugs={total})")
    print(f"    Notional deployed: ${total_not:.2f}")
    print(f"    Cash: ${cash_v}  Drawdown: ${dd_v}")
    print()

# 4. What is the leader earning on tennis vs other sports?
# We can proxy this by looking at what paper-v2 earns on each sport (since paper-v2 used to have tennis?)
# Actually paper-v2 also has slug blocking. Let's check paper-sports-b instead.
print("\n[4] PAPER-SPORTS-B fills by sport (this profile may have had tennis)\n")
rows = db.execute("""
    SELECT json_extract(le.rawJson,'$.slug') as slug,
           SUM(f.price*f.size) as buy_notional, COUNT(*) as cnt
    FROM Fill f
    JOIN "Order" o ON o.id=f.orderId
    JOIN CopyIntent ci ON ci.id=o.intentId
    LEFT JOIN LeaderEvent le ON le.id=ci.leaderEventId
    WHERE f.profileId='paper-sports-b' AND ci.side='BUY'
    GROUP BY json_extract(le.rawJson,'$.slug')
    ORDER BY cnt DESC LIMIT 20
""").fetchall()
by_sport_psb = defaultdict(lambda: {'cnt':0,'notional':0.0})
for r in rows:
    s = sport(r['slug'])
    by_sport_psb[s]['cnt'] += r['cnt']
    by_sport_psb[s]['notional'] += r['buy_notional'] or 0
for s, d in sorted(by_sport_psb.items(), key=lambda x: x[1]['cnt'], reverse=True):
    print(f"  {s:<12}  fills={d['cnt']}  notional=${d['notional']:.2f}")

# 5. p&L estimate: how much could we have made if tennis was NOT blocked?
# If paper-v2 traded tennis and made money, by extension live would have too
print("\n[5] TENNIS OPPORTUNITY COST ESTIMATE (what live missed post-block)\n")

# Look at paper-v2 after the block date - same markets were slug_blocked there too
# Check what paper-sports-b (older profile potentially with tennis) did

# Most useful: look at leader events that were slug_blocked on live after block date
# and check if paper-sports-b filled those same leaderEventIds
rows = db.execute("""
    SELECT ci_live.leaderEventId, le.price, le.side,
           json_extract(le.rawJson,'$.slug') as slug,
           ci_live.ts,
           ci_psb.status as psb_status
    FROM CopyIntent ci_live
    JOIN LeaderEvent le ON le.id=ci_live.leaderEventId
    LEFT JOIN CopyIntent ci_psb ON ci_psb.leaderEventId=ci_live.leaderEventId 
                                AND ci_psb.profileId='paper-sports-b'
    WHERE ci_live.profileId='live' 
      AND ci_live.reason='SLUG_BLOCKED'
      AND ci_live.ts >= ?
    ORDER BY ci_live.ts DESC LIMIT 100
""", (SLUG_BLOCK_INTRODUCED_MS,)).fetchall()

# Cross-reference with paper-sports-b fills
psb_fills = sum(1 for r in rows if r['psb_status'] in ('FILLED','PARTIALLY_FILLED_OK'))
psb_total = len(rows)
print(f"  SLUG_BLOCKED on live (sample 100): {psb_total}")
print(f"  Of those, paper-sports-b also FILLED: {psb_fills}")
print(f"  Of those, paper-sports-b had different action: {psb_total - psb_fills}")

print()
print("=" * 70)
print("  Done")
print("=" * 70)
