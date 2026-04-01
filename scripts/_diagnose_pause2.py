import sqlite3, json
from datetime import datetime, timezone

db = sqlite3.connect('packages/db/prisma/dev.db')
db.row_factory = sqlite3.Row

def fmt(ts):
    try:
        return datetime.fromisoformat(str(ts).replace('Z', '+00:00')).strftime('%b %d %H:%M:%S')
    except Exception:
        try:
            return datetime.fromtimestamp(int(ts)/1000, tz=timezone.utc).strftime('%b %d %H:%M:%S')
        except Exception:
            return str(ts)

print('=== ALL alerts around Mar 21 pause (00:00-02:00 UTC) ===')
rows = db.execute("""
    SELECT ts, severity, code, message, contextJson
    FROM Alert WHERE profileId='live'
    AND ts >= '2026-03-21T00:00:00Z' AND ts <= '2026-03-21T02:00:00Z'
    ORDER BY ts ASC
""").fetchall()
if not rows:
    print('  (none found in that window)')
for r in rows:
    ctx = ''
    if r['contextJson']:
        try:
            c = json.loads(r['contextJson'])
            ctx = str(c)[:200]
        except Exception:
            ctx = r['contextJson'][:200]
    print(f"  [{fmt(r['ts'])}] {r['severity']:5} {r['code']}: {r['message'][:90]}")
    if ctx:
        print(f"    -> {ctx}")

print()
print('=== Total alert count for live profile ===')
count = db.execute("SELECT COUNT(*) as cnt FROM Alert WHERE profileId='live'").fetchone()
print(f"  Total: {count['cnt']}")

print()
print('=== All unique alert codes for live profile ===')
codes = db.execute("""
    SELECT DISTINCT code, severity, COUNT(*) as cnt
    FROM Alert WHERE profileId='live'
    GROUP BY code, severity ORDER BY cnt DESC
""").fetchall()
for r in codes:
    print(f"  {r['severity']:5} {r['code']:40} count={r['cnt']}")

print()
print('=== Intents around Mar 21 pause (00:20-01:00 UTC) ===')
rows2 = db.execute("""
    SELECT ts, side, status, reason, desiredNotional
    FROM CopyIntent WHERE profileId='live'
    AND ts >= '2026-03-21T00:20:00Z' AND ts <= '2026-03-21T01:00:00Z'
    ORDER BY ts ASC
""").fetchall()
if not rows2:
    print('  (none found)')
for r in rows2:
    print(f"  [{fmt(r['ts'])}] {r['side']:4} {r['status']:12} {(r['reason'] or '-'):30}  notional={r['desiredNotional']}")

print()
print('=== ConfigVersion detail around pause ===')
rows3 = db.execute("""
    SELECT createdAt, json FROM ConfigVersion
    WHERE profileId='live'
    ORDER BY createdAt ASC
""").fetchall()
for r in rows3:
    cfg = json.loads(r['json'])
    safety = cfg.get('safety', {})
    budget = cfg.get('budget', {})
    print(f"  {fmt(r['createdAt'])}  paused={safety.get('paused')}  killSwitch={safety.get('killSwitch')}  maxDailyDrawdown={budget.get('maxDailyDrawdownUSDC')}")

db.close()
