"""
Deep comparison: which markets did live vs paper-v2 trade?
And specifically: outcome per sport, geo-blocked markets, position-level P&L
"""
import sqlite3, json
from datetime import datetime, timezone

DB = 'packages/db/prisma/dev.db'
db = sqlite3.connect(DB)
db.row_factory = sqlite3.Row

now_ms = int(datetime.now(timezone.utc).timestamp() * 1000)
since_30d_ms = now_ms - 30 * 24 * 3600 * 1000

def ms(ts):
    try: return datetime.fromtimestamp(int(ts)/1000, tz=timezone.utc).strftime('%m-%d %H:%M')
    except: return str(ts)[:16]

def sport(slug):
    if not slug: return 'other'
    s = slug.lower()
    for p, label in [('atp-','tennis'),('wta-','tennis'),('tennis-','tennis'),
                     ('mlb-','mlb'),('nhl-','nhl'),('nba-','nba'),('nfl-','nfl'),
                     ('ncaa-','ncaa'),('ufc-','ufc'),('golf-','golf'),
                     ('epl-','soccer'),('mls-','soccer'),('ucl-','soccer'),
                     ('laliga-','soccer'),('soccer-','soccer')]:
        if s.startswith(p): return label
    return 'other'

print("=" * 70)
print("  MARKET-LEVEL COMPARISON: live vs paper-v2")
print("=" * 70)

# ── 1. Geo-restricted slugs summary ─────────────────────────────────
print("\n[1] ALL GEO_RESTRICTED markets (live, all-time)\n")
rows = db.execute("""
    SELECT json_extract(le.rawJson,'$.slug') as slug, COUNT(*) as cnt,
           AVG(le.price) as avg_price
    FROM CopyIntent ci
    JOIN LeaderEvent le ON le.id=ci.leaderEventId
    WHERE ci.profileId='live' AND ci.reason='GEO_RESTRICTED'
    GROUP BY slug ORDER BY cnt DESC LIMIT 30
""").fetchall()
print(f"  {'sport':<10} {'slug':<50} {'cnt':>5} {'avg_p':>7}")
print("  " + "-" * 76)
for r in rows:
    slug = r['slug'] or '(null)'
    print(f"  {sport(slug):<10} {slug:<50} {r['cnt']:>5}  {r['avg_price']:.3f}")

# ── 2. Paper-v2 fills breakdown by market + outcome ─────────────────
print("\n[2] PAPER-V2 FILLS — by market with open/closed status (all-time)\n")
paper_positions = db.execute("""
    SELECT tokenId, size, avgPrice FROM Position
    WHERE profileId='paper-v2' AND size > 0.001
""").fetchall()
paper_open_tokens = {r['tokenId']: {'size': r['size'], 'avgPrice': r['avgPrice']} for r in paper_positions}

fills = db.execute("""
    SELECT json_extract(le.rawJson,'$.slug') as slug,
           ci.tokenId, ci.side, f.price as fill_p, f.size as fill_sz,
           ci.ts
    FROM Fill f
    JOIN "Order" o ON o.id=f.orderId
    JOIN CopyIntent ci ON ci.id=o.intentId
    LEFT JOIN LeaderEvent le ON le.id=ci.leaderEventId
    WHERE f.profileId='paper-v2'
    ORDER BY ci.ts DESC
""").fetchall()

# Group by slug
from collections import defaultdict
slug_data = defaultdict(lambda: {'buy_n': 0, 'sell_n': 0, 'buy_cost': 0.0, 'sell_rev': 0.0, 'slug': ''})
for r in fills:
    slug = r['slug'] or r['tokenId'][:20]
    slug_data[slug]['slug'] = slug
    notional = (r['fill_p'] or 0) * (r['fill_sz'] or 0)
    if r['side'] == 'BUY':
        slug_data[slug]['buy_n'] += 1
        slug_data[slug]['buy_cost'] += notional
    else:
        slug_data[slug]['sell_n'] += 1
        slug_data[slug]['sell_rev'] += notional

print(f"  {'sport':<8} {'slug':<48} {'buys':>5} {'sells':>5} {'closed_pnl':>10} {'status'}")
print("  " + "-" * 90)
all_closed_pnl = 0
all_open_cost = 0
for slug, d in sorted(slug_data.items(), key=lambda x: x[1]['buy_n'], reverse=True):
    sp = sport(slug)
    # Try to get tokenId for this slug
    row = db.execute("""
        SELECT ci.tokenId FROM CopyIntent ci
        LEFT JOIN LeaderEvent le ON le.id=ci.leaderEventId
        WHERE ci.profileId='paper-v2'
          AND json_extract(le.rawJson,'$.slug')=?
        LIMIT 1
    """, (slug,)).fetchone()
    token_id = row['tokenId'] if row else None
    is_open = token_id in paper_open_tokens if token_id else False
    
    if d['sell_n'] > 0 and not is_open:
        closed_pnl = d['sell_rev'] - d['buy_cost']
        all_closed_pnl += closed_pnl
        pnl_str = f"${closed_pnl:+.2f}"
        status = "CLOSED"
    elif is_open:
        pnl_str = "(open)"
        all_open_cost += d['buy_cost'] - d['sell_rev']
        status = "OPEN"
    else:
        pnl_str = "?"
        status = "?"
    print(f"  {sp:<8} {slug[:48]:<48} {d['buy_n']:>5} {d['sell_n']:>5} {pnl_str:>10}  {status}")

print()
print(f"  Total closed P&L: ${all_closed_pnl:+.2f}  |  Open unrealized cost basis: ${all_open_cost:.2f}")

# ── 3. Same-day same-slug: did live and paper-v2 overlap? ───────────
print("\n[3] SLUG OVERLAP — markets both traded (last 30d)\n")
live_slugs = db.execute("""
    SELECT DISTINCT json_extract(le.rawJson,'$.slug') as slug
    FROM Fill f
    JOIN "Order" o ON o.id=f.orderId
    JOIN CopyIntent ci ON ci.id=o.intentId
    JOIN LeaderEvent le ON le.id=ci.leaderEventId
    WHERE f.profileId='live' AND ci.ts > ?
""", (since_30d_ms,)).fetchall()
live_slug_set = {r['slug'] for r in live_slugs}

paper_slugs = db.execute("""
    SELECT DISTINCT json_extract(le.rawJson,'$.slug') as slug
    FROM Fill f
    JOIN "Order" o ON o.id=f.orderId
    JOIN CopyIntent ci ON ci.id=o.intentId
    JOIN LeaderEvent le ON le.id=ci.leaderEventId
    WHERE f.profileId='paper-v2' AND ci.ts > ?
""", (since_30d_ms,)).fetchall()
paper_slug_set = {r['slug'] for r in paper_slugs}

overlap = live_slug_set & paper_slug_set
live_only = live_slug_set - paper_slug_set
paper_only = paper_slug_set - live_slug_set

print(f"  Slugs live filled:       {len(live_slug_set)}")
print(f"  Slugs paper-v2 filled:   {len(paper_slug_set)}")
print(f"  OVERLAP (both traded):   {len(overlap)}")
print(f"  Live-only:               {len(live_only)}")
print(f"  Paper-v2-only:           {len(paper_only)}")
print()
print("  OVERLAP slugs:")
for s in sorted(overlap):
    print(f"    {sport(s):<10}  {s}")
print()
print("  PAPER-V2-ONLY slugs (live missed due to geo/rejection):")
for s in sorted(paper_only)[:25]:
    print(f"    {sport(s):<10}  {s}")

# ── 4. Live slippage cost summary ────────────────────────────────────
print("\n[4] SLIPPAGE IMPACT ON LIVE (all-time)\n")
rows = db.execute("""
    SELECT f.price as fill_p, le.price as lead_p, f.size,
           json_extract(le.rawJson,'$.slug') as slug
    FROM Fill f
    JOIN "Order" o ON o.id=f.orderId
    JOIN CopyIntent ci ON ci.id=o.intentId
    JOIN LeaderEvent le ON le.id=ci.leaderEventId
    WHERE f.profileId='live'
""").fetchall()
if rows:
    total_extra = sum(((r['fill_p'] - r['lead_p']) * r['size']) for r in rows)
    avg_bps = sum(((r['fill_p'] - r['lead_p']) / max(r['lead_p'], 0.001) * 10000) for r in rows) / len(rows)
    print(f"  Live fills:         {len(rows)}")
    print(f"  Total extra cost:   ${total_extra:+.4f}  (vs leader fill price)")
    print(f"  Average slippage:   {avg_bps:+.1f} bps  (= cent premium per $1 of face value)")
    print()
    # By sport
    by_sport = defaultdict(lambda: {'cnt': 0, 'extra': 0})
    for r in rows:
        s = sport(r['slug'] or '')
        extra = (r['fill_p'] - r['lead_p']) * r['size']
        by_sport[s]['cnt'] += 1
        by_sport[s]['extra'] += extra
    for s, d in sorted(by_sport.items(), key=lambda x: x[1]['cnt'], reverse=True):
        print(f"    {s:<12}  fills={d['cnt']:3d}  extra_cost=${d['extra']:+.4f}")

print()
print("=" * 70)
print("  Done")
print("=" * 70)
