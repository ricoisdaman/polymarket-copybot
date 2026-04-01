import sqlite3
from datetime import datetime, timezone

DB = "packages/db/prisma/dev.db"
c = sqlite3.connect(DB)
c.row_factory = sqlite3.Row

print("=== CURRENT OPEN POSITIONS ===")
sql = """
    SELECT p.tokenId, p.size, p.avgPrice, p.size*p.avgPrice as cost,
           COALESCE(json_extract(le.rawJson,'$.title'), p.tokenId) as title
    FROM Position p
    LEFT JOIN CopyIntent ci ON ci.tokenId = p.tokenId AND ci.profileId = p.profileId
    LEFT JOIN LeaderEvent le ON le.id = ci.leaderEventId
    WHERE p.profileId = 'live' AND p.size > 0
    GROUP BY p.tokenId
"""
pos = c.execute(sql).fetchall()
print(f"Count: {len(pos)}")
for p in pos:
    print(f"  size={p['size']:.4f}  price={p['avgPrice']:.4f}  cost=${p['cost']:.4f}  {str(p['title'] or p['tokenId'])[:50]}")

print()
print("=== ALL FILLS (newest first, last 25) ===")
fills = c.execute("""
    SELECT f.ts, f.price, f.price*f.size as usdc, f.size, o.side,
           COALESCE(json_extract(le.rawJson,'$.title'), ci.tokenId) as title
    FROM Fill f
    JOIN "Order" o ON o.id = f.orderId
    JOIN CopyIntent ci ON ci.id = o.intentId
    JOIN LeaderEvent le ON le.id = ci.leaderEventId
    WHERE f.profileId = 'live'
    ORDER BY f.ts DESC
    LIMIT 25
""").fetchall()
for f in fills:
    ts = datetime.fromtimestamp(f['ts']/1000, tz=timezone.utc)
    print(f"  {ts.strftime('%m-%d %H:%M UTC')}  {f['side']:4s}  ${f['price']:.4f}  ${f['usdc']:.4f}  size={f['size']:.4f}  {str(f['title'] or '')[:45]}")

print()
print("=== CASH METRIC ===")
r = c.execute("SELECT value, updatedAt FROM RuntimeMetric WHERE profileId='live' AND key='bot.cash_usdc'").fetchone()
if r:
    ts = datetime.fromtimestamp(int(r['updatedAt'])/1000, tz=timezone.utc)
    print(f"  ${float(r['value']):.4f}  (metric last updated: {ts.strftime('%H:%M UTC')})")

print()
print("=== ALL RUNTIME METRICS ===")
for row in c.execute("SELECT key, value, updatedAt FROM RuntimeMetric WHERE profileId='live' ORDER BY key").fetchall():
    ts = datetime.fromtimestamp(int(row['updatedAt'])/1000, tz=timezone.utc)
    print(f"  {row['key']:50s}  {row['value']:<20s}  @{ts.strftime('%H:%M UTC')}")

c.close()
