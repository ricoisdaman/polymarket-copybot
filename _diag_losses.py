"""
Diagnose yesterday's (April 12) losses:
- What did we fill vs what did the leader trade?
- P&L on closed positions
- Open positions at risk
- Leader profit vs our loss breakdown
"""
import sqlite3, json
from datetime import datetime, timezone, timedelta
from collections import defaultdict

DB = 'packages/db/prisma/dev.db'
db = sqlite3.connect(DB)
db.row_factory = sqlite3.Row

now_ms = int(datetime.now(timezone.utc).timestamp() * 1000)

# April 12 UTC window
apr12_start = int(datetime(2026, 4, 12, 0, 0, 0, tzinfo=timezone.utc).timestamp() * 1000)
apr12_end   = int(datetime(2026, 4, 13, 0, 0, 0, tzinfo=timezone.utc).timestamp() * 1000)
apr11_start = int(datetime(2026, 4, 11, 0, 0, 0, tzinfo=timezone.utc).timestamp() * 1000)
apr11_end   = apr12_start
# "Yesterday" from user's perspective - could mean past 24-36h
since_36h = now_ms - 36 * 3600 * 1000

def ms(ts):
    try: return datetime.fromtimestamp(int(ts)/1000, tz=timezone.utc).strftime('%m-%d %H:%M')
    except: return str(ts)[:16]

print("=" * 70)
print("  LOSS DIAGNOSIS — April 12-13")
print("=" * 70)

# 1. Cash movement on live profile
print("\n[1] LIVE BOT CASH + DRAWDOWN STATE\n")
rows = db.execute("""
    SELECT key, value FROM RuntimeMetric
    WHERE profileId='live'
    ORDER BY key
""").fetchall()
for r in rows:
    print(f"  {r['key']:45s}  {r['value']}")

# 2. ALL live fills in last 36h with market outcome
print("\n[2] ALL LIVE FILLS (last 36h) with fill vs leader price\n")
fills_36h = db.execute("""
    SELECT f.price as fill_p, f.size as fill_sz, ci.side, ci.ts, ci.status,
           le.price as lead_p, le.side as lead_side,
           json_extract(le.rawJson,'$.slug') as slug,
           json_extract(le.rawJson,'$.title') as title,
           ci.tokenId, ci.id as intent_id
    FROM Fill f
    JOIN "Order" o ON o.id=f.orderId
    JOIN CopyIntent ci ON ci.id=o.intentId
    LEFT JOIN LeaderEvent le ON le.id=ci.leaderEventId
    WHERE f.profileId='live' AND ci.ts > ?
    ORDER BY ci.ts ASC
""", (since_36h,)).fetchall()

print(f"  {'ts':12s} {'side':4s} {'lead_p':7s} {'fill_p':7s} {'slip%':6s} {'sz':6s} {'notional':9s}  slug")
print("  " + "-" * 85)
total_buy_notional = 0
total_buy_count = 0
for r in fills_36h:
    notional = r['fill_p'] * r['fill_sz']
    slip_pct = (r['fill_p'] - r['lead_p']) / max(r['lead_p'], 0.001) * 100 if r['lead_p'] else 0
    slug = (r['slug'] or r['title'] or r['tokenId'][:20] or '')[:40]
    if r['side'] == 'BUY':
        total_buy_notional += notional
        total_buy_count += 1
    print(f"  {ms(r['ts']):12s} {r['side']:4s} {r['lead_p'] or 0:.4f}  {r['fill_p']:.4f}  {slip_pct:+5.1f}%  {r['fill_sz']:.4f}  ${notional:.2f}  {slug}")

print(f"\n  Total BUY fills: {total_buy_count}, Total notional deployed: ${total_buy_notional:.2f}")

# 3. Open positions right now — how much is at risk?
print("\n[3] OPEN POSITIONS on live (current)\n")
positions = db.execute("""
    SELECT pos.tokenId, pos.size, pos.avgPrice,
           pos.updatedAt
    FROM Position pos
    WHERE pos.profileId='live' AND pos.size > 0.001
    ORDER BY pos.updatedAt DESC
""").fetchall()

total_cost = 0
print(f"  {'tokenId':20s} {'size':8s} {'avgPrice':9s} {'cost':8s}  updated")
print("  " + "-" * 65)
for p in positions:
    cost = p['size'] * p['avgPrice']
    total_cost += cost
    print(f"  {p['tokenId'][:20]:20s} {p['size']:8.4f}  {p['avgPrice']:.4f}  ${cost:.2f}  {str(p['updatedAt'])[:16]}")
print(f"\n  Total open cost basis: ${total_cost:.2f}")

# Get slug/title for open positions
if positions:
    print("\n  Open position slugs (via latest leaderEvent for token):")
    for p in positions:
        row = db.execute("""
            SELECT json_extract(le.rawJson,'$.slug') as slug,
                   json_extract(le.rawJson,'$.title') as title,
                   le.price as last_leader_p
            FROM LeaderEvent le
            WHERE le.tokenId=? AND le.profileId='live'
            ORDER BY le.ts DESC LIMIT 1
        """, (p['tokenId'],)).fetchone()
        slug = row['slug'] or row['title'] or '?' if row else '?'
        last_p = row['last_leader_p'] if row else '?'
        cost = p['size'] * p['avgPrice']
        unrealized_guess = p['size'] * float(last_p) - cost if isinstance(last_p, float) else 0
        print(f"    {p['tokenId'][:18]:18s}  size={p['size']:.4f}  cost=${cost:.2f}  last_leader_p={last_p}  est_pnl={unrealized_guess:+.2f}  {slug[:45]}")

# 4. Leader events Apr 12 that we SKIPPED — what would have been profitable?
print("\n[4] LEADER EVENTS we SKIPPED on Apr 12 (with slug and price)\n")
skips = db.execute("""
    SELECT ci.reason, le.price, le.side,
           json_extract(le.rawJson,'$.slug') as slug,
           COUNT(*) as cnt
    FROM CopyIntent ci
    JOIN LeaderEvent le ON le.id=ci.leaderEventId
    WHERE ci.profileId='live' AND ci.status='SKIPPED'
      AND ci.ts BETWEEN ? AND ?
    GROUP BY ci.reason, json_extract(le.rawJson,'$.slug'), le.side
    ORDER BY ci.reason, cnt DESC
""", (apr12_start, apr12_end)).fetchall()

reason_totals = defaultdict(lambda: {'cnt': 0, 'slugs': set()})
for r in skips:
    reason_totals[r['reason']]['cnt'] += r['cnt']
    reason_totals[r['reason']]['slugs'].add(r['slug'] or '?')

for reason, d in sorted(reason_totals.items(), key=lambda x: x[1]['cnt'], reverse=True):
    print(f"  {reason:30s}  {d['cnt']:5d} skips  ({len(d['slugs'])} unique slugs)")
    for s in sorted(d['slugs'])[:5]:
        print(f"    {s}")

# 5. What did the leader trade on Apr 12 that we blocked?
print("\n[5] LEADER Apr-12 trades we saw and SLUG_BLOCKED\n")
rows = db.execute("""
    SELECT json_extract(le.rawJson,'$.slug') as slug, 
           le.price, le.side, COUNT(*) as cnt
    FROM CopyIntent ci
    JOIN LeaderEvent le ON le.id=ci.leaderEventId
    WHERE ci.profileId='live' AND ci.reason='SLUG_BLOCKED'
      AND ci.ts BETWEEN ? AND ?
    GROUP BY json_extract(le.rawJson,'$.slug'), le.side
    ORDER BY cnt DESC LIMIT 20
""", (apr12_start, apr12_end)).fetchall()
for r in rows:
    print(f"  {str(r['slug'] or ''):45s}  side={r['side']:4s}  p={r['price']:.3f}  cnt={r['cnt']}")

# 6. REJECTED on Apr 12 (GEO_RESTRICTED etc)
print("\n[6] LIVE REJECTED on Apr 12 (orders we tried to place but failed)\n")
rows = db.execute("""
    SELECT ci.reason, json_extract(le.rawJson,'$.slug') as slug,
           le.price, COUNT(*) as cnt
    FROM CopyIntent ci
    JOIN LeaderEvent le ON le.id=ci.leaderEventId
    WHERE ci.profileId='live' AND ci.status='REJECTED'
      AND ci.ts BETWEEN ? AND ?
    GROUP BY ci.reason, json_extract(le.rawJson,'$.slug')
    ORDER BY ci.reason, cnt DESC
""", (apr12_start, apr12_end)).fetchall()
reason_rej = defaultdict(list)
for r in rows:
    reason_rej[r['reason']].append(f"{r['slug']}(p={r['price']:.2f},n={r['cnt']})")
for reason, items in reason_rej.items():
    print(f"  {reason}: {len(items)} markets")
    for i in items[:8]: print(f"    {i}")

# 7. P&L summary
print("\n[7] P&L SUMMARY\n")
cash = db.execute("SELECT value FROM RuntimeMetric WHERE profileId='live' AND key='bot.cash_usdc'").fetchone()
dd = db.execute("SELECT value FROM RuntimeMetric WHERE profileId='live' AND key='bot.drawdown_usdc'").fetchone()
start_usdc = 60  # from .env STARTING_USDC

cash_val = float(cash['value']) if cash else 0
dd_val = float(dd['value']) if dd else 0
open_cost = total_cost

print(f"  Starting USDC:    ${start_usdc:.2f}")
print(f"  Current cash:     ${cash_val:.2f}")
print(f"  Open pos cost:    ${open_cost:.2f}  (not yet realized)")
print(f"  Cash spent:       ${start_usdc - cash_val:.2f}")
print(f"  Drawdown metric:  ${dd_val:.2f}")
print(f"  Net cash P&L:     ${cash_val - start_usdc:.2f}  (excluding open positions)")

print()
print("=" * 70)
print("  Done")
print("=" * 70)
