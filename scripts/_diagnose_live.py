import sqlite3
from datetime import datetime, timezone

db = sqlite3.connect('packages/db/prisma/dev.db')
db.row_factory = sqlite3.Row

def fmt_ts_ms(ts_str):
    try:
        # ISO string from prisma
        return datetime.fromisoformat(ts_str.replace('Z', '+00:00')).strftime('%H:%M:%S')
    except Exception:
        return str(ts_str)

# 1. What profiles exist?
print('=== PROFILES IN DB (CopyIntent) ===')
for r in db.execute("SELECT DISTINCT profileId, COUNT(*) as cnt FROM CopyIntent GROUP BY profileId"):
    print(f'  {r["profileId"]}: {r["cnt"]} intents')

# 2. Live profile intents
print()
print('=== LIVE PROFILE - Last 30 intents ===')
rows = db.execute("""SELECT ts, side, status, reason, mode FROM CopyIntent
                     WHERE profileId='live' ORDER BY ts DESC LIMIT 30""").fetchall()
if not rows:
    print('  NO INTENTS FOUND for profileId=live')
else:
    for r in rows:
        print(f'  {fmt_ts_ms(r["ts"])} {r["side"]:4} {r["status"]:10} reason={r["reason"] or "-":30} mode={r["mode"]}')

# 3. Alerts for live profile
print()
print('=== LIVE PROFILE - All alerts ===')
rows = db.execute("""SELECT ts, severity, code, message FROM Alert
                     WHERE profileId='live' ORDER BY ts DESC LIMIT 30""").fetchall()
if not rows:
    print('  No alerts for profileId=live')
else:
    for r in rows:
        print(f'  [{fmt_ts_ms(r["ts"])}] {r["severity"]:7} {r["code"]}: {r["message"][:100]}')

# 4. RuntimeMetrics for live
print()
print('=== LIVE PROFILE - RuntimeMetrics ===')
rows = db.execute("SELECT key, value, updatedAt FROM RuntimeMetric WHERE profileId='live'").fetchall()
if not rows:
    print('  No metrics for profileId=live')
else:
    for r in rows:
        print(f'  {r["key"]}: {r["value"]}')

# 5. Leader events for live
print()
print('=== LIVE PROFILE - Leader events (last 20) ===')
rows = db.execute("""SELECT ts, side, price, usdcSize, tokenId FROM LeaderEvent
                     WHERE profileId='live' ORDER BY ts DESC LIMIT 20""").fetchall()
if not rows:
    print('  No leader events for profileId=live')
else:
    for r in rows:
        print(f'  {fmt_ts_ms(r["ts"])} {r["side"]:4} price={r["price"]:.4f} usdc={r["usdcSize"]:.2f}  token=...{r["tokenId"][-12:]}')

# 6. Check ALL intents skip reasons summary
print()
print('=== LIVE PROFILE - Skip reason summary ===')
rows = db.execute("""SELECT reason, COUNT(*) as cnt FROM CopyIntent
                     WHERE profileId='live' GROUP BY reason ORDER BY cnt DESC""").fetchall()
if not rows:
    print('  No intents at all for profileId=live')
else:
    total = sum(r["cnt"] for r in rows)
    for r in rows:
        pct = 100 * r["cnt"] / total
        print(f'  {r["reason"] or "FILLED":35} {r["cnt"]:5} ({pct:.1f}%)')

# 7. Check bot.feed.last_error metric for any profile
print()
print('=== FEED ERRORS (any profile) ===')
rows = db.execute("""SELECT profileId, key, value, updatedAt FROM RuntimeMetric
                     WHERE key LIKE '%error%' OR key LIKE '%feed%'""").fetchall()
if not rows:
    print('  No feed error metrics found')
else:
    for r in rows:
        print(f'  [{r["profileId"]}] {r["key"]}: {r["value"][:120]}')

db.close()
