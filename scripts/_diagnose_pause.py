import sqlite3, json
from datetime import datetime, timezone

db = sqlite3.connect('packages/db/prisma/dev.db')
db.row_factory = sqlite3.Row

def fmt(ts):
    try:
        return datetime.fromisoformat(str(ts).replace('Z', '+00:00')).strftime('%b %d %H:%M:%S')
    except Exception:
        try:
            return datetime.fromtimestamp(int(ts) / 1000, tz=timezone.utc).strftime('%b %d %H:%M:%S')
        except Exception:
            return str(ts)

print('=== WARN/ERROR alerts for live profile ===')
rows = db.execute("""
    SELECT ts, severity, code, message, contextJson
    FROM Alert WHERE profileId='live'
    AND severity IN ('WARN','ERROR','FATAL')
    ORDER BY ts DESC LIMIT 40
""").fetchall()
if not rows:
    print('  (none)')
for r in rows:
    ctx = ''
    if r['contextJson']:
        try:
            c = json.loads(r['contextJson'])
            ctx = str(c)[:150]
        except Exception:
            ctx = r['contextJson'][:150]
    print(f"  [{fmt(r['ts'])}] {r['severity']:5} {r['code']}: {r['message'][:90]}")
    if ctx:
        print(f"    -> {ctx}")

print()
print('=== ConfigVersion history (paused/kill state) ===')
rows2 = db.execute("""
    SELECT createdAt, json FROM ConfigVersion
    WHERE profileId='live'
    ORDER BY createdAt DESC LIMIT 15
""").fetchall()
for r in rows2:
    cfg = json.loads(r['json'])
    safety = cfg.get('safety', {})
    print(f"  {fmt(r['createdAt'])}  paused={safety.get('paused')}  killSwitch={safety.get('killSwitch')}")

print()
print('=== RuntimeMetrics for live ===')
rows3 = db.execute("SELECT key, value, updatedAt FROM RuntimeMetric WHERE profileId='live' ORDER BY key").fetchall()
for r in rows3:
    print(f"  {r['key']}: {r['value']}")

print()
print('=== Recent intents (last 30) ===')
rows4 = db.execute("""
    SELECT ts, side, status, reason, desiredNotional FROM CopyIntent
    WHERE profileId='live' ORDER BY ts DESC LIMIT 30
""").fetchall()
for r in rows4:
    reason = r['reason'] or '-'
    print(f"  {fmt(r['ts'])}  {r['side']:4} {r['status']:10} {reason:35} notional={r['desiredNotional']}")

print()
print('=== Fills / closed positions ===')
rows5 = db.execute("""
    SELECT f.ts, f.price, f.size, f.fee, o.side
    FROM Fill f
    JOIN "Order" o ON f.orderId = o.id
    JOIN CopyIntent ci ON o.intentId = ci.id
    WHERE ci.profileId='live'
    ORDER BY f.ts DESC LIMIT 20
""").fetchall()
if not rows5:
    print('  (no fills)')
for r in rows5:
    print(f"  {fmt(r['ts'])}  {r['side']:4} price={r['price']}  size={r['size']}  fee={r['fee']}")

db.close()
