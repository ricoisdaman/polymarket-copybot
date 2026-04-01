import sqlite3
from datetime import datetime, timezone

DB = "packages/db/prisma/dev.db"
c = sqlite3.connect(DB)
c.row_factory = sqlite3.Row

# Show all tables and columns safely
print("=== DB TABLES ===")
tables = [r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type='table'")]
for t in tables:
    cols = [r[1] for r in c.execute(f'PRAGMA table_info("{t}")')]
    print(f"  {t}: {cols}")

if False:  # placeholder — replaced below
    for row in c.execute("SELECT 1").fetchall():
        d = dict(row)
    for k, v in d.items():
        if k in ('updatedAt', 'ts') and v:
            try:
                d[k] = f"{v}  ({datetime.fromtimestamp(int(v)/1000, tz=timezone.utc).strftime('%m-%d %H:%M UTC')})"
            except:
                pass
    print(d)

print()
print("=== ALERTS (all, newest first) ===")
alerts = c.execute("SELECT * FROM Alert WHERE profileId='live' ORDER BY ts DESC LIMIT 50").fetchall()
if not alerts:
    print("  (no alerts)")
for a in alerts:
    ts = datetime.fromtimestamp(a['ts']/1000, tz=timezone.utc)
    print(f"  {ts.strftime('%m-%d %H:%M UTC')}  {str(a['type'] or ''):30s}  {str(a['message'] or '')[:100]}")

print()
print("=== RECENT SKIPS (PAUSED) ===")
skips = c.execute("""
    SELECT ci.ts, ci.skipReason, ci.tokenId,
           json_extract(le.rawJson,'$.title') as title,
           json_extract(le.rawJson,'$.price') as price
    FROM CopyIntent ci
    JOIN LeaderEvent le ON le.id = ci.leaderEventId
    WHERE ci.profileId='live' AND ci.skipReason='PAUSED'
    ORDER BY ci.ts DESC LIMIT 20
""").fetchall()
if not skips:
    print("  (no PAUSED skips in DB)")
for s in skips:
    ts = datetime.fromtimestamp(s['ts']/1000, tz=timezone.utc)
    print(f"  {ts.strftime('%m-%d %H:%M UTC')}  price={s['price']}  {str(s['title'] or s['tokenId'] or '')[:60]}")

print()
print("=== RECENT FILLS (last 15) ===")
fills = c.execute("""
    SELECT f.ts, f.price, f.price*f.size as usdc, f.size, o.side,
           json_extract(le.rawJson,'$.title') as title
    FROM Fill f
    JOIN "Order" o ON o.id = f.orderId
    JOIN CopyIntent ci ON ci.id = o.intentId
    JOIN LeaderEvent le ON le.id = ci.leaderEventId
    WHERE f.profileId = 'live'
    ORDER BY f.ts DESC LIMIT 15
""").fetchall()
for f in fills:
    ts = datetime.fromtimestamp(f['ts']/1000, tz=timezone.utc)
    print(f"  {ts.strftime('%m-%d %H:%M UTC')}  {f['side']:4s}  ${f['price']:.4f}  ${f['usdc']:.4f}  {str(f['title'] or '')[:55]}")

print()
print("=== ALL RUNTIME METRICS ===")
for row in c.execute("SELECT key, value, updatedAt FROM RuntimeMetric WHERE profileId='live' ORDER BY key").fetchall():
    ts = datetime.fromtimestamp(int(row['updatedAt'])/1000, tz=timezone.utc)
    print(f"  {row['key']:50s}  {str(row['value']):<25s}  @{ts.strftime('%m-%d %H:%M UTC')}")

c.close()
