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

print('=== All fills (live profile) ===')
rows = db.execute("""
    SELECT f.ts, o.side, f.price, f.size, ci.tokenId,
           COALESCE(
               (SELECT le.rawJson FROM LeaderEvent le WHERE le.id = ci.leaderEventId LIMIT 1),
               '{}'
           ) as raw
    FROM Fill f
    JOIN "Order" o ON f.orderId = o.id
    JOIN CopyIntent ci ON o.intentId = ci.id
    WHERE ci.profileId='live'
    ORDER BY f.ts DESC LIMIT 20
""").fetchall()
if not rows:
    print('  (no fills)')
for r in rows:
    raw = {}
    try:
        raw = json.loads(r['raw'])
    except Exception:
        pass
    title = raw.get('title') or raw.get('question') or raw.get('marketTitle') or ''
    title = title[:50] if title else r['tokenId'][:20]+'...'
    notional = r['price'] * r['size']
    print(f"  {fmt(r['ts'])}  {r['side']:4} @ {r['price']:.4f}  size={r['size']:.4f}  notional=${notional:.2f}  market: {title}")

print()
print('=== Current RuntimeMetrics ===')
rows2 = db.execute("SELECT key, value FROM RuntimeMetric WHERE profileId='live' ORDER BY key").fetchall()
for r in rows2:
    print(f"  {r['key']:40} = {r['value']}")

print()
print('=== DB Positions (live) ===')
rows3 = db.execute("SELECT tokenId, size, avgPrice, updatedAt FROM Position WHERE profileId='live' ORDER BY size DESC").fetchall()
if not rows3:
    print('  (none)')
for r in rows3:
    notional = r['size'] * r['avgPrice']
    print(f"  tokenId={r['tokenId'][:20]}...  size={r['size']:.4f}  avgPrice={r['avgPrice']:.4f}  notional=${notional:.2f}  updated={fmt(r['updatedAt'])}")

print()
print('=== Recent skipped intents (last 10) ===')
rows4 = db.execute("""
    SELECT ts, side, status, reason, desiredNotional, mode
    FROM CopyIntent WHERE profileId='live' AND status='SKIPPED'
    ORDER BY ts DESC LIMIT 10
""").fetchall()
for r in rows4:
    print(f"  {fmt(r['ts'])}  {r['side']:4} {r['reason']:40} notional=${r['desiredNotional']:.2f}")

db.close()
