import sqlite3, json
from datetime import datetime, timezone

DB = "packages/db/prisma/dev.db"
c = sqlite3.connect(DB)
c.row_factory = sqlite3.Row

def ts(ms):
    return datetime.fromtimestamp(ms/1000, tz=timezone.utc).strftime("%m-%d %H:%M:%S UTC")

# Pause happened at 23:23 UTC today. Look at all orders in the window around 23:12-23:25 UTC
# (fills at 23:12, pause at 23:23)
pause_ts = 1774654980000  # approx 03-27 23:23 UTC
window_start = pause_ts - 30 * 60 * 1000  # 30 min before
window_end   = pause_ts + 10 * 60 * 1000  # 10 min after

print("=== All orders in window 22:53-23:33 UTC ===")
orders = c.execute("""
    SELECT o.id, o.ts, o.status, o.side, o.price, o.size, o.profileId,
           json_extract(le.rawJson,'$.title') as title,
           ci.reason as skipReason
    FROM "Order" o
    JOIN CopyIntent ci ON ci.id=o.intentId
    JOIN LeaderEvent le ON le.id=ci.leaderEventId
    WHERE o.profileId='live' AND o.ts BETWEEN ? AND ?
    ORDER BY o.ts ASC
""", (window_start, window_end)).fetchall()
for o in orders:
    print(f"  {ts(o['ts'])}  {o['status']:20s}  {o['side']:4s}  ${o['price']:.4f}  {str(o['title'] or '')[:50]}")

print()
print("=== All PLACED orders (never resolved) ===")
stuck = c.execute("""
    SELECT o.id, o.ts, o.status, o.side, o.price, o.size,
           json_extract(le.rawJson,'$.title') as title
    FROM "Order" o
    JOIN CopyIntent ci ON ci.id=o.intentId
    JOIN LeaderEvent le ON le.id=ci.leaderEventId
    WHERE o.profileId='live' AND o.status='PLACED'
    ORDER BY o.ts DESC LIMIT 10
""").fetchall()
print(f"  count={len(stuck)}")
for o in stuck:
    print(f"  {ts(o['ts'])}  {o['status']:20s}  {o['side']:4s}  ${o['price']:.4f}  {str(o['title'] or '')[:50]}")
    print(f"    orderId={o['id']}")

print()
print("=== Orders with status LIVE_ORDER_NOT_FILLED or CHASE_CANCELLED ===")
for status in ('LIVE_ORDER_NOT_FILLED', 'CHASE_CANCELLED', 'EXPIRED'):
    rows = c.execute("""
        SELECT o.ts, o.status, o.side, o.price, o.size,
               json_extract(le.rawJson,'$.title') as title
        FROM "Order" o
        JOIN CopyIntent ci ON ci.id=o.intentId
        JOIN LeaderEvent le ON le.id=ci.leaderEventId
        WHERE o.profileId='live' AND o.status=?
        ORDER BY o.ts DESC LIMIT 5
    """, (status,)).fetchall()
    if rows:
        print(f"\n  {status} (last 5):")
        for o in rows:
            print(f"    {ts(o['ts'])}  {o['side']:4s}  ${o['price']:.4f}  {str(o['title'] or '')[:55]}")

print()
print("=== All distinct Order statuses ===")
for row in c.execute("SELECT status, COUNT(*) as n FROM \"Order\" WHERE profileId='live' GROUP BY status ORDER BY n DESC").fetchall():
    print(f"  {str(row['status'] or 'NULL'):30s}  {row['n']}")

print()
print("=== Orders around the TWO pauses (00:54 UTC and 23:23 UTC) ===")
for label, t_ms in [("Pause 1 @ 00:54 UTC", 1774572760000), ("Pause 2 @ 23:23 UTC", 1774654980000)]:
    print(f"\n  -- {label} --")
    rows = c.execute("""
        SELECT o.ts, o.status, o.side, o.price, o.size,
               json_extract(le.rawJson,'$.title') as title
        FROM "Order" o
        JOIN CopyIntent ci ON ci.id=o.intentId
        JOIN LeaderEvent le ON le.id=ci.leaderEventId
        WHERE o.profileId='live' AND o.ts BETWEEN ? AND ?
        ORDER BY o.ts ASC
    """, (t_ms - 45*60*1000, t_ms + 5*60*1000)).fetchall()
    for o in rows:
        marker = " ← STUCK?" if o['status'] not in ('FILLED', 'CANCELLED') else ""
        print(f"    {ts(o['ts'])}  {o['status']:25s}  {o['side']:4s}  ${o['price']:.4f}  {str(o['title'] or '')[:45]}{marker}")

c.close()
