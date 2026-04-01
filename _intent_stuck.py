import sqlite3, json
from datetime import datetime, timezone

DB = "packages/db/prisma/dev.db"
c = sqlite3.connect(DB)
c.row_factory = sqlite3.Row

def ts(ms):
    return datetime.fromtimestamp(ms/1000, tz=timezone.utc).strftime("%m-%d %H:%M:%S UTC")

print("=== CopyIntent status breakdown ===")
for row in c.execute("SELECT status, COUNT(*) as n FROM CopyIntent WHERE profileId='live' GROUP BY status ORDER BY n DESC").fetchall():
    print(f"  {str(row['status'] or 'NULL'):20s}  {row['n']}")

print()
print("=== CopyIntent reason breakdown ===")
for row in c.execute("SELECT reason, COUNT(*) as n FROM CopyIntent WHERE profileId='live' GROUP BY reason ORDER BY n DESC").fetchall():
    print(f"  {str(row['reason'] or 'NULL'):40s}  {row['n']}")

print()
print("=== CopyIntent columns ===")
for r in c.execute('PRAGMA table_info("CopyIntent")'):
    print(f"  col: {dict(r)}")

print()
print("=== Recent CopyIntents (last 30) ===")
rows = c.execute("""
    SELECT ci.ts, ci.status, ci.reason, ci.mode,
           json_extract(le.rawJson,'$.title') as title,
           le.price, le.side
    FROM CopyIntent ci
    JOIN LeaderEvent le ON le.id = ci.leaderEventId
    WHERE ci.profileId='live'
    ORDER BY ci.ts DESC LIMIT 30
""").fetchall()
for r in rows:
    print(f"  {ts(r['ts'])}  status={str(r['status'] or ''):15s}  reason={str(r['reason'] or ''):35s}  {r['side']:3s}  {r['price']}  {str(r['title'] or '')[:45]}")

print()
print("=== CopyIntents with status PLACED (stuck ones) ===")
placed = c.execute("""
    SELECT ci.ts, ci.status, ci.reason, ci.id,
           json_extract(le.rawJson,'$.title') as title,
           le.price, le.side
    FROM CopyIntent ci
    JOIN LeaderEvent le ON le.id = ci.leaderEventId
    WHERE ci.profileId='live' AND ci.status='PLACED'
    ORDER BY ci.ts DESC LIMIT 20
""").fetchall()
print(f"  count={len(placed)}")
for r in placed:
    print(f"  {ts(r['ts'])}  {r['side']:3s}  {r['price']}  {str(r['title'] or '')[:55]}")
    print(f"    intentId={r['id']}")

print()
print("=== CopyIntents around pause 1 (00:39-00:54 UTC) ===")
for r in c.execute("""
    SELECT ci.ts, ci.status, ci.reason,
           json_extract(le.rawJson,'$.title') as title, le.price, le.side
    FROM CopyIntent ci JOIN LeaderEvent le ON le.id=ci.leaderEventId
    WHERE ci.profileId='live' AND ci.ts BETWEEN 1774570800000 AND 1774573200000
    ORDER BY ci.ts ASC
""").fetchall():
    print(f"  {ts(r['ts'])}  status={str(r['status'] or ''):15s}  reason={str(r['reason'] or ''):30s}  {r['side']:3s}  p={r['price']}  {str(r['title'] or '')[:40]}")

print()
print("=== CopyIntents around pause 2 (23:10-23:25 UTC) ===")
for r in c.execute("""
    SELECT ci.ts, ci.status, ci.reason,
           json_extract(le.rawJson,'$.title') as title, le.price, le.side
    FROM CopyIntent ci JOIN LeaderEvent le ON le.id=ci.leaderEventId
    WHERE ci.profileId='live' AND ci.ts BETWEEN 1774654200000 AND 1774655400000
    ORDER BY ci.ts ASC
""").fetchall():
    print(f"  {ts(r['ts'])}  status={str(r['status'] or ''):15s}  reason={str(r['reason'] or ''):30s}  {r['side']:3s}  p={r['price']}  {str(r['title'] or '')[:40]}")

c.close()
