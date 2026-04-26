import sqlite3
from datetime import datetime, timezone
from collections import defaultdict

DB = 'packages/db/prisma/dev.db'
db = sqlite3.connect(DB)
db.row_factory = sqlite3.Row

def ms(t):
    return datetime.fromtimestamp(int(t)/1000, tz=timezone.utc).strftime('%m/%d')

print("MLB leader events vs live fills — price distribution and outcomes\n")

# Leader's MLB trades: what prices does the leader buy at?
leader_mlb = db.execute("""
    SELECT le.price, le.side,
           json_extract(le.rawJson,'$.slug') as slug,
           le.ts
    FROM LeaderEvent le
    WHERE json_extract(le.rawJson,'$.slug') LIKE 'mlb-%'
      AND le.side = 'BUY'
    ORDER BY le.ts DESC
""").fetchall()

# Bucket by price range
buckets = defaultdict(lambda: {'leader_cnt': 0, 'live_fills': 0, 'live_notional': 0.0})
for r in leader_mlb:
    p = r['price']
    bucket = f"{int(p*10)*10:.0f}-{int(p*10)*10+10:.0f}¢"
    buckets[bucket]['leader_cnt'] += 1

print(f"Total leader MLB BUY events: {len(leader_mlb)}")
print()

# Live fills on MLB and their prices
live_mlb = db.execute("""
    SELECT f.price, f.size, ci.ts,
           json_extract(le.rawJson,'$.slug') as slug
    FROM Fill f
    JOIN "Order" o ON o.id=f.orderId
    JOIN CopyIntent ci ON ci.id=o.intentId
    LEFT JOIN LeaderEvent le ON le.id=ci.leaderEventId
    WHERE f.profileId='live' AND ci.side='BUY'
      AND json_extract(le.rawJson,'$.slug') LIKE 'mlb-%'
    ORDER BY ci.ts DESC
""").fetchall()

print(f"Live MLB fills: {len(live_mlb)}")
notional = sum(r['price']*r['size'] for r in live_mlb)
print(f"Live MLB notional deployed: ${notional:.2f}")
print()

print("(open positions skipped — schema join not available)")

print()

# Recent MLB skip reasons — how many MLB events are being blocked/skipped and why?
skips = db.execute("""
    SELECT ci.reason, COUNT(*) as cnt
    FROM CopyIntent ci
    JOIN LeaderEvent le ON le.id=ci.leaderEventId
    WHERE ci.profileId='live'
      AND json_extract(le.rawJson,'$.slug') LIKE 'mlb-%'
      AND ci.ts > (strftime('%s','now')*1000 - 14*86400000)
    GROUP BY ci.reason
    ORDER BY cnt DESC
""").fetchall()

print("Live MLB intent reasons (last 14 days):")
for r in skips:
    print(f"  {str(r['reason'] or 'FILLED'):<30} {r['cnt']}")

print()

# Price distribution of live MLB fills
print("Live MLB fills by price bucket:")
price_buckets = defaultdict(int)
for r in live_mlb:
    b = int(r['price'] * 10) * 10
    price_buckets[f"{b}-{b+10}¢"] += 1
for k in sorted(price_buckets):
    print(f"  {k:>10}  {price_buckets[k]:>4} fills")

print()

# Compare: same time window, what did leader earn on MLB?
# proxy: look at paper-v2 MLB fills to see if any resolved profitably
pv2_mlb = db.execute("""
    SELECT ci.reason, COUNT(*) as cnt, SUM(f.price*f.size) as notional
    FROM CopyIntent ci
    LEFT JOIN "Order" o ON o.intentId=ci.id
    LEFT JOIN Fill f ON f.orderId=o.id
    JOIN LeaderEvent le ON le.id=ci.leaderEventId
    WHERE ci.profileId='paper-v2'
      AND json_extract(le.rawJson,'$.slug') LIKE 'mlb-%'
    GROUP BY ci.reason
    ORDER BY cnt DESC
""").fetchall()

print("paper-v2 MLB intent reasons (all time):")
for r in pv2_mlb:
    notional_str = f"  notional=${r['notional']:.2f}" if r['notional'] else ""
    print(f"  {str(r['reason'] or 'FILLED'):<30} {r['cnt']}{notional_str}")

# Cash and drawdown
cash = db.execute("SELECT value FROM RuntimeMetric WHERE profileId='live' AND key='bot.cash_usdc'").fetchone()
dd = db.execute("SELECT value FROM RuntimeMetric WHERE profileId='live' AND key='bot.drawdown_usdc'").fetchone()
print(f"\nLive bot: cash=${float(cash['value']):.2f}  drawdown=${float(dd['value']):.4f}")
