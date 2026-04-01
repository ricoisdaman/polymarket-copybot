import sqlite3
from datetime import datetime, timezone

DB = "packages/db/prisma/dev.db"
c = sqlite3.connect(DB)
c.row_factory = sqlite3.Row

print("=" * 70)
print("  INVESTIGATING MISSED MIAMI OPEN TRADES")
print("=" * 70)

# 1. Look for any leader events mentioning Rybakina or Pegula
print("\n--- LeaderEvents matching 'rybakina' or 'pegula' or 'miami' ---")
events = c.execute("""
    SELECT le.id, le.ts, le.tokenId, le.side, le.price, le.size,
           json_extract(le.rawJson, '$.title') as title,
           json_extract(le.rawJson, '$.question') as question,
           le.rawJson
    FROM LeaderEvent le
    WHERE le.profileId = 'live'
      AND (
        LOWER(le.rawJson) LIKE '%rybakina%'
        OR LOWER(le.rawJson) LIKE '%pegula%'
        OR LOWER(le.rawJson) LIKE '%miami%'
      )
    ORDER BY le.ts DESC
    LIMIT 20
""").fetchall()

if events:
    for e in events:
        print(f"  ts={e['ts']}  side={e['side']}  price={e['price']}  title={e['title'] or e['question'] or '?'}")
        print(f"    tokenId={e['tokenId']}")
        # check for copy intents
        intents = c.execute("""
            SELECT ci.id, ci.status, ci.reason, ci.ts
            FROM CopyIntent ci
            WHERE ci.leaderEventId = ?
        """, (e['id'],)).fetchall()
        if intents:
            for i in intents:
                print(f"    → CopyIntent: status={i['status']}  reason={i['reason']}  ts={i['ts']}")
        else:
            print(f"    → NO CopyIntent found for this leader event!")
else:
    print("  *** NO leader events found for miami/rybakina/pegula! ***")
    print("  This means the bot never saw these trades from the leader feed.")

# 2. Current bot state
print("\n--- Current Runtime State ---")
state = c.execute("""
    SELECT key, value FROM RuntimeMetric
    WHERE profileId = 'live'
      AND key IN ('bot.heartbeat_ts','bot.cash_usdc','bot.daily_notional_usdc',
                  'bot.open_positions','control.kill_switch','control.paused',
                  'bot.starting_balance_usdc')
    ORDER BY key
""").fetchall()
for s in state:
    val = s['value']
    if s['key'] == 'bot.heartbeat_ts':
        try:
            ts_sec = int(val) / 1000
            dt = datetime.fromtimestamp(ts_sec, tz=timezone.utc)
            val += f"  = {dt.strftime('%Y-%m-%d %H:%M:%S UTC')}"
        except: pass
    print(f"  {s['key']:42s}  {val}")

# 3. Current control state
print("\n--- Control State ---")
ctrl = c.execute("""
    SELECT key, value FROM RuntimeMetric
    WHERE profileId = 'live' AND key LIKE 'control.%'
""").fetchall()
if ctrl:
    for s in ctrl:
        print(f"  {s['key']:42s}  {s['value']}")
else:
    print("  (no control metrics found)")

# 4. Most recent leader events (any) to see if bot feed is alive
print("\n--- Last 10 leader events seen (any market) ---")
recent = c.execute("""
    SELECT le.ts, le.side, le.price,
           COALESCE(json_extract(le.rawJson,'$.title'), json_extract(le.rawJson,'$.question'), le.tokenId) as title
    FROM LeaderEvent le
    WHERE le.profileId = 'live'
    ORDER BY le.ts DESC
    LIMIT 10
""").fetchall()
for r in recent:
    print(f"  ts={r['ts']}  {r['side']:4s}  ${r['price']:.4f}  {(r['title'] or '')[:50]}")

# 5. Most recent copy intents (any)
print("\n--- Last 10 copy intents (any status) ---")
recent_i = c.execute("""
    SELECT ci.ts, ci.status, ci.reason, ci.side,
           COALESCE(json_extract(le.rawJson,'$.title'), json_extract(le.rawJson,'$.question'), ci.tokenId) as title
    FROM CopyIntent ci
    LEFT JOIN LeaderEvent le ON le.id = ci.leaderEventId
    WHERE ci.profileId = 'live'
    ORDER BY ci.ts DESC
    LIMIT 10
""").fetchall()
for r in recent_i:
    print(f"  ts={r['ts']}  {r['status']:8s}  {r['reason'] or '':35s}  {(r['title'] or '')[:40]}")

# 6. Skip reasons in last 24h
print("\n--- Skip reasons in most recent activity ---")
recent_skips = c.execute("""
    SELECT ci.reason, COUNT(*) as cnt
    FROM CopyIntent ci
    WHERE ci.profileId = 'live'
      AND ci.status = 'SKIPPED'
      AND ci.ts > datetime('now', '-24 hours')
    GROUP BY ci.reason
    ORDER BY cnt DESC
""").fetchall()
if recent_skips:
    for s in recent_skips:
        print(f"  {s['reason']:45s}  {s['cnt']}")
else:
    print("  (no skips in last 24h)")

# 7. Check if daily notional cap could be issue
print("\n--- Daily Notional Check ---")
metrics_dict = {s['key']: s['value'] for s in state}
daily = float(metrics_dict.get('bot.daily_notional_usdc', 0))
limit = 30.0  # from .env MAX_DAILY_NOTIONAL_USDC
print(f"  Daily spent so far:  ${daily:.4f}")
print(f"  Daily limit:         ${limit:.4f}")
print(f"  Remaining:           ${limit - daily:.4f}")

c.close()
