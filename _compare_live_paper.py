"""
Compare live bot vs paper-v2 performance:
- Which markets each traded vs missed
- Fill price vs leader price slippage
- P&L breakdown
- Why live is rejecting orders that paper-v2 fills
"""
import sqlite3, json
from datetime import datetime, timezone

DB = 'packages/db/prisma/dev.db'
db = sqlite3.connect(DB)
db.row_factory = sqlite3.Row

now_ms = int(datetime.now(timezone.utc).timestamp() * 1000)
since_7d_ms  = now_ms - 7  * 24 * 3600 * 1000
since_30d_ms = now_ms - 30 * 24 * 3600 * 1000
since_24h_ms = now_ms - 24 * 3600 * 1000

def ms(ts):
    try: return datetime.fromtimestamp(int(ts)/1000, tz=timezone.utc).strftime('%m-%d %H:%M')
    except: return str(ts)[:16]

print("=" * 70)
print("  LIVE vs PAPER-V2 — PERFORMANCE COMPARISON")
print("=" * 70)

# ── 1. Summary counts (all-time) ─────────────────────────────────────
print("\n[1] OVERALL INTENT SUMMARY (all-time)\n")
for pid in ['live', 'paper-v2']:
    rows = db.execute("""
        SELECT status, reason, COUNT(*) as cnt
        FROM CopyIntent WHERE profileId=?
        GROUP BY status, reason ORDER BY cnt DESC
    """, (pid,)).fetchall()
    total = sum(r['cnt'] for r in rows)
    filled = sum(r['cnt'] for r in rows if r['status'] in ('FILLED','PARTIALLY_FILLED_OK'))
    skipped = sum(r['cnt'] for r in rows if r['status'] == 'SKIPPED')
    rejected = sum(r['cnt'] for r in rows if r['status'] == 'REJECTED')
    print(f"  {pid}:  total={total}  filled={filled}  skipped={skipped}  rejected={rejected}")

# ── 2. Rejection reasons — why live can't execute ────────────────────
print("\n[2] LIVE REJECTION REASONS (all-time)\n")
rows = db.execute("""
    SELECT reason, COUNT(*) as cnt
    FROM CopyIntent WHERE profileId='live' AND status='REJECTED'
    GROUP BY reason ORDER BY cnt DESC
""").fetchall()
for r in rows:
    print(f"  {str(r['reason'] or 'null'):40s}  {r['cnt']:5d}")

# ── 3. Markets paper-v2 filled that live REJECTED (GEO_RESTRICTED) ──
print("\n[3] MARKETS live=GEO_RESTRICTED but paper-v2=FILLED (all-time, top 20 slugs)\n")
# Get all live geo-rejected tokens
live_geo = db.execute("""
    SELECT DISTINCT ci.tokenId
    FROM CopyIntent ci
    WHERE ci.profileId='live' AND ci.reason='GEO_RESTRICTED'
""").fetchall()
live_geo_tokens = set(r['tokenId'] for r in live_geo)

# For those same tokens, check paper-v2 fills
if live_geo_tokens:
    placeholders = ','.join('?' * len(live_geo_tokens))
    paper_fills = db.execute(f"""
        SELECT ci.tokenId, ci.ts,
               json_extract(le.rawJson,'$.slug') as slug,
               json_extract(le.rawJson,'$.title') as title,
               le.price as leader_price,
               o.price as fill_price, o.size as fill_size
        FROM CopyIntent ci
        JOIN LeaderEvent le ON le.id=ci.leaderEventId
        JOIN "Order" o ON o.intentId=ci.id
        WHERE ci.profileId='paper-v2' AND ci.tokenId IN ({placeholders})
          AND ci.status IN ('FILLED','PARTIALLY_FILLED_OK')
        ORDER BY ci.ts DESC
        LIMIT 100
    """, list(live_geo_tokens)).fetchall()
    
    slug_pnl = {}
    for r in paper_fills:
        slug = r['slug'] or r['title'] or r['tokenId'][:20]
        if slug not in slug_pnl:
            slug_pnl[slug] = {'fills': 0, 'notional': 0}
        slug_pnl[slug]['fills'] += 1
        slug_pnl[slug]['notional'] += (r['fill_price'] or 0) * (r['fill_size'] or 0)
    
    sorted_slugs = sorted(slug_pnl.items(), key=lambda x: x[1]['fills'], reverse=True)[:20]
    print(f"  Tokens geo-restricted on live: {len(live_geo_tokens)}")
    print(f"  Paper-v2 fills on those tokens: {len(paper_fills)}")
    print()
    fmt = "{:<55} {:>5} {:>10}"
    print(fmt.format("slug/title", "fills", "notional$"))
    print("-" * 73)
    for slug, d in sorted_slugs:
        print(fmt.format(slug[:55], d['fills'], f"${d['notional']:.2f}"))
else:
    print("  (no geo-restricted tokens found)")

# ── 4. P&L comparison via fills ──────────────────────────────────────
print("\n[4] P&L via fills (all-time)\n")
for pid in ['live', 'paper-v2']:
    fills = db.execute("""
        SELECT f.price, f.size, ci.side, ci.tokenId, ci.ts,
               json_extract(le.rawJson,'$.slug') as slug
        FROM Fill f
        JOIN "Order" o ON o.id=f.orderId
        JOIN CopyIntent ci ON ci.id=o.intentId
        LEFT JOIN LeaderEvent le ON le.id=ci.leaderEventId
        WHERE f.profileId=?
        ORDER BY ci.ts DESC
    """, (pid,)).fetchall()
    
    total_buy_notional = sum(r['price']*r['size'] for r in fills if r['side']=='BUY')
    total_sell_notional = sum(r['price']*r['size'] for r in fills if r['side']=='SELL')
    buy_count = sum(1 for r in fills if r['side']=='BUY')
    sell_count = sum(1 for r in fills if r['side']=='SELL')
    
    # Current open positions value
    positions = db.execute("""
        SELECT p.tokenId, p.size, p.avgPrice
        FROM Position p WHERE p.profileId=? AND p.size > 0.001
    """, (pid,)).fetchall()
    open_notional = sum(r['size']*r['avgPrice'] for r in positions)
    
    cash = db.execute("""
        SELECT value FROM RuntimeMetric WHERE profileId=? AND key='bot.cash_usdc'
    """, (pid,)).fetchone()
    cash_val = float(cash['value']) if cash else 0
    
    print(f"  {pid}:")
    print(f"    Total fills:       {len(fills)} ({buy_count} BUY, {sell_count} SELL)")
    print(f"    BUY notional:      ${total_buy_notional:.2f}")
    print(f"    SELL notional:     ${total_sell_notional:.2f}")
    print(f"    Current cash:      ${cash_val:.2f}")
    print(f"    Open pos cost:     ${open_notional:.2f}")
    print()

# ── 5. Fills on same leader event — price comparison ─────────────────
print("\n[5] SAME LEADER EVENT — fill price vs leader price (last 7d, live)\n")
rows = db.execute("""
    SELECT le.price as leader_p, f.price as fill_p, f.size,
           json_extract(le.rawJson,'$.slug') as slug, ci.ts,
           ((f.price - le.price) / le.price * 100) as slippage_pct
    FROM Fill f
    JOIN "Order" o ON o.id=f.orderId
    JOIN CopyIntent ci ON ci.id=o.intentId
    JOIN LeaderEvent le ON le.id=ci.leaderEventId
    WHERE f.profileId='live' AND ci.ts > ?
    ORDER BY ci.ts DESC LIMIT 30
""", (since_7d_ms,)).fetchall()
if not rows:
    print("  (no live fills in last 7d)")
else:
    total_slip = 0
    fmt = "{:<40} {:>7} {:>7} {:>8}  {}"
    print(fmt.format("slug", "lead_p", "fill_p", "slip%", "ts"))
    print("-" * 75)
    for r in rows:
        slip = r['slippage_pct'] or 0
        total_slip += slip
        print(fmt.format(
            (r['slug'] or '')[:40],
            f"{r['leader_p']:.4f}",
            f"{r['fill_p']:.4f}",
            f"{slip:+.2f}%",
            ms(r['ts'])
        ))
    avg_slip = total_slip / len(rows) if rows else 0
    print(f"\n  Average slippage: {avg_slip:+.3f}%  (positive = overpaid vs leader)")

# ── 6. Sports breakdown — where does paper-v2 outperform live ────────
print("\n[6] FILLS BY SPORT — live vs paper-v2 (all-time)\n")
for pid in ['live', 'paper-v2']:
    rows = db.execute("""
        SELECT json_extract(le.rawJson,'$.slug') as slug, COUNT(*) as cnt,
               SUM(f.price * f.size) as notional
        FROM Fill f
        JOIN "Order" o ON o.id=f.orderId
        JOIN CopyIntent ci ON ci.id=o.intentId
        JOIN LeaderEvent le ON le.id=ci.leaderEventId
        WHERE f.profileId=? AND ci.side='BUY'
        GROUP BY json_extract(le.rawJson,'$.slug')
        ORDER BY cnt DESC LIMIT 30
    """, (pid,)).fetchall()
    
    sport_totals = {}
    for r in rows:
        slug = r['slug'] or ''
        sport = 'tennis' if any(slug.startswith(p) for p in ['atp-','wta-','tennis-']) else \
                'mlb' if slug.startswith('mlb-') else \
                'nhl' if slug.startswith('nhl-') else \
                'nba' if slug.startswith('nba-') else \
                'nfl' if slug.startswith('nfl-') else \
                'soccer' if any(slug.startswith(p) for p in ['epl-','ucl-','mls-','laliga-','soccer-']) else \
                'other'
        if sport not in sport_totals:
            sport_totals[sport] = {'fills': 0, 'notional': 0}
        sport_totals[sport]['fills'] += r['cnt']
        sport_totals[sport]['notional'] += r['notional'] or 0
    
    print(f"  {pid}:")
    for sport, d in sorted(sport_totals.items(), key=lambda x: x[1]['fills'], reverse=True):
        print(f"    {sport:<12}  fills={d['fills']:4d}  notional=${d['notional']:.2f}")
    print()

# ── 7. Specific markets: what is paper-v2 trading live is not ────────
print("\n[7] MARKETS where live=REJECTED/SKIPPED but paper-v2=FILLED (last 30d)\n")
# Get all leader events seen by live that didn't result in a fill
live_nonfill_events = db.execute("""
    SELECT ci.leaderEventId, ci.status, ci.reason,
           json_extract(le.rawJson,'$.slug') as slug,
           le.price
    FROM CopyIntent ci
    JOIN LeaderEvent le ON le.id=ci.leaderEventId
    WHERE ci.profileId='live'
      AND ci.status IN ('SKIPPED','REJECTED')
      AND ci.ts > ?
""", (since_30d_ms,)).fetchall()

live_nonfill_ids = {r['leaderEventId']: r for r in live_nonfill_events}

# Check which of those paper-v2 filled
if live_nonfill_ids:
    placeholders = ','.join('?' * min(len(live_nonfill_ids), 900))
    ids_sample = list(live_nonfill_ids.keys())[:900]
    paper_counter = db.execute(f"""
        SELECT ci.leaderEventId, ci.reason, ci.status,
               json_extract(le.rawJson,'$.slug') as slug, le.price
        FROM CopyIntent ci
        JOIN LeaderEvent le ON le.id=ci.leaderEventId
        WHERE ci.profileId='paper-v2'
          AND ci.leaderEventId IN ({placeholders})
          AND ci.status IN ('FILLED','PARTIALLY_FILLED_OK')
    """, ids_sample).fetchall()
    
    reason_breakdown = {}
    for pc in paper_counter:
        le = live_nonfill_ids.get(pc['leaderEventId'], {})
        reason = le.get('reason') if hasattr(le, 'get') else dict(le).get('reason', '?') if le else '?'
        reason_breakdown[reason] = reason_breakdown.get(reason, 0) + 1
    
    print(f"  Live non-fills in last 30d where paper-v2 DID fill:")
    for reason, cnt in sorted(reason_breakdown.items(), key=lambda x: x[1], reverse=True):
        print(f"    live_reason={str(reason):35s}  paper_filled={cnt}")

print()
print("=" * 70)
print("  Done")
print("=" * 70)
