import sqlite3, json
from datetime import datetime, timezone
db = sqlite3.connect('packages/db/prisma/dev.db')
db.row_factory = sqlite3.Row

now_ms = int(datetime.now(timezone.utc).timestamp() * 1000)
since_24h_ms = now_ms - 24*3600*1000

# 1. Live REJECTED intents - why are so many rejected in LIVE mode?
print("=== REJECTED intents on 'live' (last 24h) ===")
rows = db.execute("""
    SELECT ci.reason, COUNT(*) as cnt
    FROM CopyIntent ci
    WHERE ci.profileId='live' AND ci.status='REJECTED' AND ci.ts > ?
    GROUP BY ci.reason ORDER BY cnt DESC
""", (since_24h_ms,)).fetchall()
for r in rows:
    print(f"  reason={str(r['reason'] or 'null'):40s}  count={r['cnt']}")

print()
print("=== Sample REJECTED live intents (last 10) ===")
rows = db.execute("""
    SELECT ci.ts, ci.status, ci.reason, le.price, le.side,
           json_extract(le.rawJson,'$.slug') as slug
    FROM CopyIntent ci
    LEFT JOIN LeaderEvent le ON le.id = ci.leaderEventId
    WHERE ci.profileId='live' AND ci.status='REJECTED' AND ci.ts > ?
    ORDER BY ci.ts DESC LIMIT 10
""", (since_24h_ms,)).fetchall()
for r in rows:
    ts = datetime.fromtimestamp(int(r['ts'])/1000, tz=timezone.utc).strftime('%H:%M:%S')
    print(f"  {ts}  {str(r['reason'] or ''):35s}  p={r['price']}  {str(r['slug'] or '')[:40]}")

# 2. Beta SLUG_BLOCKED - which prefixes?
print()
print("=== SLUG_BLOCKED slugs on 'beta' (last 24h) ===")
rows = db.execute("""
    SELECT json_extract(le.rawJson,'$.slug') as slug, COUNT(*) as cnt
    FROM CopyIntent ci
    JOIN LeaderEvent le ON le.id = ci.leaderEventId
    WHERE ci.profileId='beta' AND ci.reason='SLUG_BLOCKED' AND ci.ts > ?
    GROUP BY slug ORDER BY cnt DESC LIMIT 20
""", (since_24h_ms,)).fetchall()
if not rows:
    print("  (none)")
for r in rows:
    print(f"  {str(r['slug'] or 'null'):55s}  {r['cnt']:5d}")

# 3. Current RuntimeMetric for beta config
print()
print("=== Beta RuntimeMetrics ===")
rows = db.execute("""
    SELECT key, value FROM RuntimeMetric WHERE profileId='beta' ORDER BY key
""").fetchall()
for r in rows:
    print(f"  {r['key']:45s}  {r['value'][:60] if r['value'] else ''}")

# 4. Active config for live and paper-v2
print()
print("=== Active config for live + paper-v2 (BLOCKED_SLUG_PREFIXES) ===")
for pid in ['live','paper-v2','beta']:
    row = db.execute("""
        SELECT json FROM ConfigVersion WHERE profileId=? AND active=1 ORDER BY createdAt DESC LIMIT 1
    """, (pid,)).fetchone()
    if not row:
        print(f"  {pid}: (no active config)")
        continue
    try:
        cfg = json.loads(row['json'])
        f = cfg.get('filters', {})
        print(f"  {pid}:")
        print(f"    blockedSlugPrefixes: {f.get('blockedSlugPrefixes', [])}")
        print(f"    minPrice: {f.get('minPrice')}  maxPrice: {f.get('maxPrice')}")
    except Exception as e:
        print(f"  {pid}: parse error: {e}")

# 5. paper-v3 drawdown stop details
print()
print("=== paper-v3 drawdown state ===")
rows = db.execute("""
    SELECT key, value FROM RuntimeMetric WHERE profileId='paper-v3'
    AND key IN ('bot.cash_usdc','bot.drawdown_usdc','bot.starting_usdc','bot.heartbeat_ts')
    ORDER BY key
""").fetchall()
for r in rows:
    print(f"  {r['key']:40s}  {r['value']}")
