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

print('=== INTENT_STUCK + LIVE_EXECUTION_ERROR alerts ===')
rows = db.execute("""
    SELECT ts, severity, code, message, contextJson
    FROM Alert WHERE profileId='live'
    AND code IN ('INTENT_STUCK','LIVE_EXECUTION_ERROR','DAILY_DRAWDOWN_STOP','BOT_HEARTBEAT_STALE','ERROR_STORM')
    ORDER BY ts ASC
""").fetchall()
if not rows:
    print('  (none)')
for r in rows:
    ctx = json.loads(r['contextJson']) if r['contextJson'] else {}
    print(f"[{fmt(r['ts'])}] {r['severity']} {r['code']}: {r['message']}")
    print(f"  ctx: {ctx}")

print()
print('=== Intents in PLACED/EXECUTING status ===')
rows2 = db.execute("""
    SELECT ts, side, status, reason, desiredNotional, conditionId, tokenId
    FROM CopyIntent WHERE profileId='live'
    AND status IN ('PLACED','EXECUTING','FILLED')
    ORDER BY ts DESC LIMIT 20
""").fetchall()
if not rows2:
    print('  (none)')
for r in rows2:
    print(f"  [{fmt(r['ts'])}] {r['side']:4} {r['status']:12} {(r['reason'] or '-'):20}  notional={r['desiredNotional']:.2f}  cond={str(r['conditionId'])[:20]}...")

print()
print('=== Orders table for live intents ===')
rows3 = db.execute("""
    SELECT o.id, o.status, o.side, o.price, o.size, o.createdAt, ci.ts as intentTs
    FROM \"Order\" o
    JOIN CopyIntent ci ON o.intentId = ci.id
    WHERE ci.profileId='live'
    ORDER BY o.createdAt DESC LIMIT 20
""").fetchall()
if not rows3:
    print('  (none)')
for r in rows3:
    print(f"  [{fmt(r['createdAt'])}] order status={r['status']:12} {r['side']:4} price={r['price']}  size={r['size']}")

db.close()
