import sqlite3
from datetime import datetime, timezone
DB = 'packages/db/prisma/dev.db'
db = sqlite3.connect(DB)
db.row_factory = sqlite3.Row

def ms(t):
    return datetime.fromtimestamp(int(t)/1000, tz=timezone.utc).strftime('%m/%d %H:%M')

print("paper-v2 tennis fills:")
rows = db.execute("""
    SELECT ci.ts, json_extract(le.rawJson,'$.slug') as slug, f.price, f.size
    FROM Fill f
    JOIN "Order" o ON o.id=f.orderId
    JOIN CopyIntent ci ON ci.id=o.intentId
    LEFT JOIN LeaderEvent le ON le.id=ci.leaderEventId
    WHERE f.profileId='paper-v2' AND ci.side='BUY'
      AND (json_extract(le.rawJson,'$.slug') LIKE 'atp-%'
        OR json_extract(le.rawJson,'$.slug') LIKE 'wta-%'
        OR json_extract(le.rawJson,'$.slug') LIKE 'tennis-%')
    ORDER BY ci.ts DESC LIMIT 20
""").fetchall()
for r in rows:
    print(f"  {ms(r['ts'])}  {str(r['slug'] or ''):<45}  p={r['price']:.3f}")

print()
print("LIVE daily fill count and notional:")
daily = db.execute("""
    SELECT CAST(ci.ts/86400000 as int) as day_epoch,
           COUNT(*) as fills,
           SUM(f.price*f.size) as notional,
           MIN(ci.ts) as ts
    FROM Fill f
    JOIN "Order" o ON o.id=f.orderId
    JOIN CopyIntent ci ON ci.id=o.intentId
    WHERE f.profileId='live' AND ci.side='BUY'
    GROUP BY CAST(ci.ts/86400000 as int)
    ORDER BY day_epoch
""").fetchall()
for r in daily:
    dt = datetime.fromtimestamp(r['ts']/1000, tz=timezone.utc).strftime('%m/%d %a')
    print(f"  {dt}  fills={r['fills']:4d}  notional=${r['notional']:.2f}")
