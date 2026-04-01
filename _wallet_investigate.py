import sqlite3
from datetime import datetime, timezone

DB = "packages/db/prisma/dev.db"
c = sqlite3.connect(DB)
c.row_factory = sqlite3.Row

print("=" * 70)
print("  WALLET BALANCE vs BOT CASH STATE INVESTIGATION")
print("=" * 70)

# What fills happened and exactly what cash they produced
fills = c.execute("""
    SELECT f.ts, f.price, f.size, f.price*f.size as usdc, o.side, ci.tokenId,
           COALESCE(json_extract(le.rawJson,'$.title'), ci.tokenId) as title
    FROM Fill f
    JOIN "Order" o ON o.id = f.orderId
    JOIN CopyIntent ci ON ci.id = o.intentId
    JOIN LeaderEvent le ON le.id = ci.leaderEventId
    WHERE f.profileId = 'live'
    ORDER BY f.ts ASC
""").fetchall()

# Key timestamps
hb_ts       = 1774478355595  # 22:39 UTC (now)
prev_hb_ts  = 1774454289151  # ~16:00 UTC (earlier analysis session)
paused_end  = hb_ts - int(5.08 * 3600 * 1000)  # ~17:31 UTC (approx paused period end)
insuff_ts   = hb_ts - int(4.75 * 3600 * 1000)  # ~17:54 UTC (time of INSUFFICIENT skip)

print(f"\n  Now (heartbeat):               {datetime.fromtimestamp(hb_ts/1000, tz=timezone.utc).strftime('%H:%M UTC')}")
print(f"  Earlier analysis session:      {datetime.fromtimestamp(prev_hb_ts/1000, tz=timezone.utc).strftime('%H:%M UTC')}")
print(f"  INSUFFICIENT skip approx:      ~17:54 UTC")
print(f"  PAUSED period:                 16:24-17:37 UTC")

# Current position states
positions = c.execute("""
    SELECT tokenId, size, avgPrice FROM Position
    WHERE profileId='live' AND size > 0
""").fetchall()
print(f"\n  Open positions in DB right now: {len(positions)}")

# All orders in non-terminal state
open_orders = c.execute("""
    SELECT o.id, o.ts, o.status, o.side, o.price, o.size, ci.tokenId,
           COALESCE(json_extract(le.rawJson,'$.title'), ci.tokenId) as title
    FROM "Order" o
    JOIN CopyIntent ci ON ci.id = o.intentId
    JOIN LeaderEvent le ON le.id = ci.leaderEventId
    WHERE o.profileId='live' AND o.status NOT IN ('FILLED', 'CANCELLED', 'EXPIRED')
    ORDER BY o.ts DESC
    LIMIT 10
""").fetchall()
print(f"  Open/pending orders in DB:      {len(open_orders)}")
for o in open_orders:
    print(f"    {str(o['ts'])[:19]}  {o['status']:12s}  {(o['title'] or '')[:35]}")

# Reconstruct cash at the 4 key moments
print("\n--- Cash reconstruction at key timestamps ---")
STARTING = 10.0

def cash_from_fills_at(ts_cutoff_ms, fills):
    """Cash from fills only (no on-chain resolutions) up to ts_cutoff."""
    net = 0.0
    for f in fills:
        ts = f['ts'] if isinstance(f['ts'], int) else int(f['ts'])
        if ts > ts_cutoff_ms:
            break
        usdc = f['usdc']
        if f['side'] == 'BUY':
            net -= usdc
        else:
            net += usdc
    return STARTING + net

# How many fills exist before each key time
for label, ts_ms in [
    ("Before PAUSED @ 16:24 UTC", hb_ts - int(6.25*3600*1000)),
    ("At PAUSED end ~17:37 UTC",  hb_ts - int(5.03*3600*1000)),
    ("At INSUFFICIENT ~17:54 UTC", hb_ts - int(4.75*3600*1000)),
    ("Earlier analysis ~16:00 UTC", prev_hb_ts),
    ("Now (22:39 UTC)",             hb_ts),
]:
    fills_before = [f for f in fills if (f['ts'] if isinstance(f['ts'], int) else int(f['ts'])) <= ts_ms]
    cash_if_no_resolutions = cash_from_fills_at(ts_ms, fills)
    last_fill_dt = datetime.fromtimestamp((fills_before[-1]['ts'] if isinstance(fills_before[-1]['ts'], int) else int(fills_before[-1]['ts']))/1000, tz=timezone.utc).strftime('%m-%d %H:%M UTC') if fills_before else 'none'
    buys = [f for f in fills_before if f['side'] == 'BUY']
    print(f"  {label:38s}  fills={len(fills_before):2d} (buys={len(buys):2d})  cash (no resolutions)=${cash_if_no_resolutions:8.4f}  last_fill={last_fill_dt}")

# The 4 positions at midnight
print("\n--- 4 midnight positions (key to the mystery) ---")
midnight_fills = [f for f in fills if '03-25 0' in datetime.fromtimestamp((f['ts'] if isinstance(f['ts'], int) else int(f['ts']))/1000, tz=timezone.utc).strftime('%m-%d %H')]
for f in midnight_fills:
    ts = f['ts'] if isinstance(f['ts'], int) else int(f['ts'])
    dt = datetime.fromtimestamp(ts/1000, tz=timezone.utc)
    # Are they still open?
    pos = c.execute("SELECT size FROM Position WHERE profileId='live' AND tokenId=?", (f['tokenId'],)).fetchone()
    print(f"  {dt.strftime('%H:%M UTC')}  ${f['price']:.4f}  shares={f['size']:.4f}  cost=${f['usdc']:.4f}  DB size now: {pos['size'] if pos else 0.0:.4f}  {(f['title'] or '')[:35]}")

total_midnight_cost = sum(f['usdc'] for f in midnight_fills if f['side']=='BUY')
print(f"  Total cost for these 4: ${total_midnight_cost:.4f}")

# The critical difference: wallet shows USDC balance, which does NOT include
# unclaimable tokens. If midnight positions hadn't paid out yet at restart:
print(f"\n--- The key calculation ---")
metric = c.execute("SELECT value FROM RuntimeMetric WHERE profileId='live' AND key='bot.cash_usdc'").fetchone()
current_cash = float(metric['value'])
print(f"  Current wallet USDC (via reconcile): ${current_cash:.4f}")
print(f"  Cash at ~16:00 UTC analysis:         $16.6612  (from earlier session)")
print(f"  Difference:                          ${16.6612 - current_cash:.4f}  (one position not yet paid out?)")
print()
print(f"  Hypothesis: at 17:37-17:54 UTC, the midnight positions had won")
print(f"  but Polymarket hadn't processed the on-chain USDC claim yet.")
print(f"  Real wallet USDC at that moment ≈ ${current_cash - total_midnight_cost:.4f}")
avail = current_cash - total_midnight_cost - 2.0 - 0.25
print(f"  After reserve+buffer: ${avail:.4f}  (needed: $3)")
if avail < 3:
    print(f"  → INSUFFICIENT confirmed ✓")
else:
    print(f"  → This does NOT explain INSUFFICIENT — another cause")

print()
# Final runtime state
print("--- Final runtime metrics ---")
for key in ['bot.cash_usdc','bot.daily_notional_usdc','bot.open_positions']:
    r = c.execute("SELECT value FROM RuntimeMetric WHERE profileId='live' AND key=?", (key,)).fetchone()
    if r:
        print(f"  {key:42s}: {r['value']}")

c.close()
