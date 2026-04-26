import sqlite3, json
from datetime import datetime, timezone
db = sqlite3.connect('packages/db/prisma/dev.db')
db.row_factory = sqlite3.Row

now_ms = int(datetime.now(timezone.utc).timestamp() * 1000)
since_24h_ms = now_ms - 24*3600*1000
since_8h_ms  = now_ms - 8*3600*1000

def ms_to_hms(ms):
    try:
        return datetime.fromtimestamp(int(ms)/1000, tz=timezone.utc).strftime('%H:%M:%S')
    except:
        return str(ms)[:19]

print("=== SKIP REASONS per profile (last 24h) ===")
rows = db.execute("""
    SELECT profileId, reason, COUNT(*) as cnt
    FROM CopyIntent
    WHERE ts > ? AND status = 'SKIPPED'
    GROUP BY profileId, reason
    ORDER BY profileId, cnt DESC
""", (since_24h_ms,)).fetchall()
if not rows:
    print("  (no skipped intents in last 24h)")
for r in rows:
    print(f"  {r['profileId']:16s}  {str(r['reason'] or 'null'):30s}  {r['cnt']:5d}")

print()
print("=== ACTUAL TRADES per profile (last 24h) ===")
rows = db.execute("""
    SELECT profileId, status, COUNT(*) as cnt
    FROM CopyIntent
    WHERE ts > ? AND status NOT IN ('SKIPPED','PENDING')
    GROUP BY profileId, status
    ORDER BY profileId, cnt DESC
""", (since_24h_ms,)).fetchall()
if not rows:
    print("  *** ZERO TRADES in last 24h ***")
for r in rows:
    print(f"  {r['profileId']:16s}  {r['status']:20s}  {r['cnt']:5d}")

print()
print("=== SLUG_BLOCKED slugs on live (last 24h, top 20) ===")
rows = db.execute("""
    SELECT json_extract(le.rawJson, '$.slug') as slug, COUNT(*) as cnt
    FROM CopyIntent ci
    JOIN LeaderEvent le ON le.id = ci.leaderEventId
    WHERE ci.profileId = 'live' AND ci.reason = 'SLUG_BLOCKED' AND ci.ts > ?
    GROUP BY slug ORDER BY cnt DESC LIMIT 20
""", (since_24h_ms,)).fetchall()
if not rows:
    print("  (none - SLUG_BLOCKED not firing on live in last 24h)")
for r in rows:
    slug = r['slug'] or '(no slug)'
    print(f"  {slug[:55]:55s}  {r['cnt']:5d}")

print()
print("=== PRICE distribution of live leader events (last 24h) ===")
rows = db.execute("""
    SELECT le.price, le.side, json_extract(le.rawJson, '$.slug') as slug
    FROM LeaderEvent le
    WHERE le.profileId = 'live' AND le.ts > ?
    ORDER BY le.ts DESC LIMIT 50
""", (since_24h_ms,)).fetchall()
buckets = {'<0.10': 0, '0.10-0.60': 0, '0.60-0.88': 0, '>0.88': 0}
for r in rows:
    p = r['price']
    if p < 0.10:       buckets['<0.10'] += 1
    elif p < 0.60:     buckets['0.10-0.60'] += 1
    elif p <= 0.88:    buckets['0.60-0.88'] += 1
    else:              buckets['>0.88'] += 1
for k, v in buckets.items():
    print(f"  {k:12s}: {v:4d}")
print()
print("  Recent 15 live leader events:")
for r in list(rows)[:15]:
    slug = (r['slug'] or '')[:45]
    print(f"    p={r['price']:.4f}  {r['side']:4s}  {slug}")

print()
print("=== Non-PRICE_FILTER intents on live (last 24h) ===")
rows = db.execute("""
    SELECT ci.status, ci.reason, le.price, json_extract(le.rawJson,'$.slug') as slug, ci.ts
    FROM CopyIntent ci
    LEFT JOIN LeaderEvent le ON le.id = ci.leaderEventId
    WHERE ci.profileId = 'live'
      AND ci.ts > ?
      AND (ci.reason != 'PRICE_FILTER' OR ci.reason IS NULL)
    ORDER BY ci.ts DESC LIMIT 30
""", (since_24h_ms,)).fetchall()
if not rows:
    print("  (all intents are PRICE_FILTER or none)")
for r in rows:
    slug = (r['slug'] or '')[:40]
    hms = ms_to_hms(r['ts'])
    print(f"  {hms}  {str(r['status'] or ''):10s}  {str(r['reason'] or ''):25s}  p={r['price']}  {slug}")

print()
print("=== Control state (paused/kill_switch) ===")
for pid in ['live', 'paper-v2', 'beta']:
    rows = db.execute("""
        SELECT key, value FROM RuntimeMetric
        WHERE profileId = ? AND key LIKE 'control.%'
        ORDER BY key
    """, (pid,)).fetchall()
    if rows:
        for r in rows:
            print(f"  {pid:16s}  {r['key']:30s}  {r['value']}")
    else:
        print(f"  {pid}: (no control metrics)")
