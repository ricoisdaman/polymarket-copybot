import sqlite3
from datetime import datetime, timezone

DB = "packages/db/prisma/dev.db"
c = sqlite3.connect(DB)
c.row_factory = sqlite3.Row

# The INSUFFICIENT skips happened at around 17:54 UTC
# The PAUSED period was 16:24-17:37 UTC
# Let's reconstruct what cash state the bot would have had at restart
# by looking at fills and when positions resolved

print("=" * 70)
print("  CASH STATE RECONSTRUCTION AT 17:54 UTC")
print("=" * 70)

# 1. All fills in order with cumulative cash
print("\n--- All fills with running cash total ---")
fills = c.execute("""
    SELECT f.ts, f.price, f.size, f.price*f.size as usdc, o.side,
           COALESCE(json_extract(le.rawJson,'$.title'), ci.tokenId) as title
    FROM Fill f
    JOIN "Order" o ON o.id = f.orderId
    JOIN CopyIntent ci ON ci.id = o.intentId
    JOIN LeaderEvent le ON le.id = ci.leaderEventId
    WHERE f.profileId = 'live'
    ORDER BY f.ts ASC
""").fetchall()

STARTING = 10.0
cash = STARTING
for f in fills:
    ts = f['ts'] if isinstance(f['ts'], int) else int(f['ts'])
    dt = datetime.fromtimestamp(ts/1000, tz=timezone.utc)
    if f['side'] == 'BUY':
        cash -= f['usdc']
    else:
        cash += f['usdc']
    print(f"  {dt.strftime('%m-%d %H:%M UTC')}  {f['side']:4s}  ${f['price']:.4f}  usdc=${f['usdc']:.4f}  running_cash=${cash:.4f}  {(f['title'] or '')[:30]}")

print(f"\n  Cash from fills alone: ${cash:.4f}")
print("  (does not include on-chain resolution payouts)")

# 2. What was in Position table at the time of restart?
print("\n--- Current Position table (open positions in DB) ---")
positions = c.execute("""
    SELECT tokenId, size, avgPrice, updatedAt
    FROM Position
    WHERE profileId = 'live' AND size > 0
    ORDER BY updatedAt DESC
""").fetchall()
if positions:
    for p in positions:
        print(f"  {p['tokenId'][-20:]}  size={p['size']:.4f}  avg={p['avgPrice']:.4f}  updated={str(p['updatedAt'])[:16]}")
else:
    print("  (none)")

# 3. Look for the PAUSED alert to find when/why it paused
print("\n--- Alerts around the PAUSED period (16:00-18:00 UTC) ---")
alerts = c.execute("""
    SELECT a.ts, a.severity, a.code, a.message
    FROM Alert a
    WHERE a.profileId = 'live'
      AND a.ts >= datetime('now', '-12 hours')
    ORDER BY a.ts ASC
""").fetchall()
if alerts:
    for a in alerts:
        print(f"  {str(a['ts'])[:19]}  {a['severity']:5s}  {a['code']:30s}  {a['message'][:40]}")
else:
    print("  (no recent alerts)")

# 4. What filled AFTER 17:37 restart (when PAUSED ended)?
# The PAUSED period ended at ~17:37 UTC today
target_ts_ms = 1774478355595  # heartbeat now (22:39 UTC)
resume_ts_ms = target_ts_ms - (5*3600*1000)  # 5h ago = 17:39 UTC (approx when paused ended)

print(f"\n--- Fills since ~17:37 UTC (after PAUSED period ended) ---")
fills_since = c.execute("""
    SELECT f.ts, f.price, f.size, f.price*f.size as usdc, o.side,
           COALESCE(json_extract(le.rawJson,'$.title'), ci.tokenId) as title
    FROM Fill f
    JOIN "Order" o ON o.id = f.orderId
    JOIN CopyIntent ci ON ci.id = o.intentId
    JOIN LeaderEvent le ON le.id = ci.leaderEventId
    WHERE f.profileId = 'live'
      AND f.ts > datetime('now', '-6 hours')
    ORDER BY f.ts ASC
""").fetchall()
if fills_since:
    for f in fills_since:
        print(f"  {str(f['ts'])[:19]}  {f['side']:4s}  ${f['price']:.4f}  usdc=${f['usdc']:.4f}  {(f['title'] or '')[:35]}")
else:
    print("  (no fills in last 6 hours)")

# 5. When did the 4 hockey positions fill, and when would they have resolved?
print("\n--- Hockey fills (last batch) with estimated resolution ---")
hockey = c.execute("""
    SELECT f.ts, f.price, f.size, f.price*f.size as usdc,
           COALESCE(json_extract(le.rawJson,'$.title'), ci.tokenId) as title,
           ci.tokenId
    FROM Fill f
    JOIN "Order" o ON o.id = f.orderId
    JOIN CopyIntent ci ON ci.id = o.intentId
    JOIN LeaderEvent le ON le.id = ci.leaderEventId
    WHERE f.profileId = 'live' AND o.side = 'BUY'
    ORDER BY f.ts DESC
    LIMIT 8
""").fetchall()
for f in hockey:
    ts = f['ts'] if isinstance(f['ts'], int) else int(f['ts'])
    dt = datetime.fromtimestamp(ts/1000, tz=timezone.utc)
    pos = c.execute("SELECT size FROM Position WHERE profileId='live' AND tokenId=?", (f['tokenId'],)).fetchone()
    size = pos['size'] if pos else 'GONE (resolved)'
    print(f"  {dt.strftime('%m-%d %H:%M UTC')}  ${f['price']:.4f}  title={str(f['title'] or '')[:35]}  position_now={size}")

# 6. The REAL cash question: what does the recent RuntimeMetric history
# show (it only stores current, but let's see bot.cash_usdc right now vs
# what the wallet calculation would be based on fills)
print("\n--- Cash reconciliation ---")
rm = c.execute("SELECT value FROM RuntimeMetric WHERE profileId='live' AND key='bot.cash_usdc'").fetchone()
current_metric_cash = float(rm['value']) if rm else None
print(f"  bot.cash_usdc metric (now): ${current_metric_cash:.4f}")

total_bought = sum(f['usdc'] for f in fills if f['side'] == 'BUY')
total_sold   = sum(f['usdc'] for f in fills if f['side'] == 'SELL')
print(f"  Total USDC bought via fills:  ${total_bought:.4f}")
print(f"  Total USDC sold via fills:    ${total_sold:.4f}")
print(f"  Net from fills:               ${STARTING + total_sold - total_bought:.4f}")
print(f"  Implied on-chain resolutions: ${current_metric_cash - (STARTING + total_sold - total_bought):.4f}")

# If the 4 hockey positions were open at restart time (17:37), wallet would show:
# cash_from_fills + any resolved payments BEFORE restart
fills4 = c.execute("""
    SELECT f.ts, f.price*f.size as usdc, o.side
    FROM Fill f
    JOIN "Order" o ON o.id = f.orderId
    JOIN CopyIntent ci ON ci.id = o.intentId
    WHERE f.profileId = 'live'
    ORDER BY f.ts DESC
    LIMIT 4
""").fetchall()
last4_usdc = sum(f['usdc'] for f in fills4 if f['side'] == 'BUY')
print(f"\n  If bot restarted at 17:37 UTC with 4 hockey positions still open:")
print(f"    wallet cash ≈ ${current_metric_cash:.4f} (resolved) - ${last4_usdc:.4f} (still locked) = ${current_metric_cash - last4_usdc:.4f}")
print(f"    available  = ${current_metric_cash - last4_usdc:.4f} - $2.00 - $0.25 = ${current_metric_cash - last4_usdc - 2.25:.4f}")
if current_metric_cash - last4_usdc - 2.25 < 3:
    print(f"    → WOULD be INSUFFICIENT (< $3.00 per trade)")
else:
    print(f"    → Would be SUFFICIENT (>= $3.00 per trade)")

c.close()
