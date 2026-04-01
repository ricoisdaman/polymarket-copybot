"""
Clean P&L summary for DEFAULT profile only (real money).
"""
import sqlite3, os

DB = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'packages', 'db', 'prisma', 'dev.db'))
src = sqlite3.connect(f'file:{DB}?mode=ro&immutable=1', uri=True)
mem = sqlite3.connect(':memory:')
src.backup(mem)
src.close()
c = mem.cursor()

PROFILE = 'default'

print(f"=== DEFAULT PROFILE FILLS ===")
buys = c.execute("""
  SELECT COUNT(*), SUM(f.price*f.size), SUM(f.size)
  FROM Fill f JOIN [Order] o ON f.orderId = o.id
  WHERE o.profileId=? AND o.side='BUY'
""", (PROFILE,)).fetchone()
sells = c.execute("""
  SELECT COUNT(*), SUM(f.price*f.size), SUM(f.size)
  FROM Fill f JOIN [Order] o ON f.orderId = o.id
  WHERE o.profileId=? AND o.side='SELL'
""", (PROFILE,)).fetchone()
print(f"  BUY fills:  {buys[0]:3d}  notional=${buys[1]:.4f}  shares={buys[2]:.4f}")
print(f"  SELL fills: {sells[0]:3d}  notional=${sells[1]:.4f}  shares={sells[2]:.4f}")
print(f"  Net cash deployed:    ${buys[1]-sells[1]:.4f}  (spent minus received)")
print(f"  Net shares remaining: {buys[2]-sells[2]:.4f}")

print(f"\n=== PER-TOKEN P&L (default profile, FIFO) ===")
all_fills = c.execute("""
  SELECT f.ts, o.side, ci.tokenId, f.price, f.size, f.fee
  FROM Fill f
  JOIN [Order] o ON f.orderId = o.id
  JOIN CopyIntent ci ON o.intentId = ci.id
  WHERE o.profileId=?
  ORDER BY ci.tokenId, f.ts
""", (PROFILE,)).fetchall()

from collections import defaultdict
token_data = defaultdict(list)
for row in all_fills:
    ts, side, tokenId, price, size, fee = row
    token_data[tokenId].append((ts, side, price, size, fee))

results = []
for tokenId, fills in token_data.items():
    buy_q = []
    realized = 0.0
    open_cost = 0.0
    open_shares = 0.0
    fees = 0.0
    for ts, side, price, size, fee in sorted(fills, key=lambda x: x[0]):
        fees += fee
        if side == 'BUY':
            buy_q.append([price, size])
            open_cost += price * size
            open_shares += size
        elif side == 'SELL':
            rem = size
            while rem > 1e-9 and buy_q:
                bp, bs = buy_q[0]
                consumed = min(bs, rem)
                realized += (price - bp) * consumed
                open_cost -= bp * consumed
                open_shares -= consumed
                rem -= consumed
                buy_q[0][1] -= consumed
                if buy_q[0][1] < 1e-9:
                    buy_q.pop(0)
    # DB position
    db_pos = c.execute("SELECT size, avgPrice FROM Position WHERE tokenId=? AND profileId=?", (tokenId, PROFILE)).fetchone()
    db_size = db_pos[0] if db_pos else 0.0
    db_avg = db_pos[1] if db_pos else 0.0
    last_px = fills[-1][2]
    avg_open = open_cost / open_shares if open_shares > 0.001 else 0.0
    unrealized = open_shares * (last_px - avg_open)
    results.append((realized + unrealized, tokenId, open_shares, realized, unrealized, last_px, db_size, db_avg))

results.sort(reverse=True)
total_realized = 0.0
total_unrealized = 0.0
open_value = 0.0
print(f"  {'Token (short)':20} {'OpenSh':>10} {'Realized':>10} {'Unrealized':>12} {'Total':>10} {'LastPx':>8} {'DB':>8}")
print(f"  {'-'*85}")
for pnl, tok, os_, real, unreal, lpx, dbs, dbavg in results:
    status = 'open' if os_ > 0.001 else 'closed'
    db_flag = '' if abs(dbs - os_) < 0.01 else f' [DB={dbs:.2f}!]'
    print(f"  {tok[:20]:20} {os_:>10.4f} {real:>10.4f} {unreal:>12.4f} {pnl:>10.4f}  {lpx:.4f} {dbs:>8.4f} [{status}]{db_flag}")
    total_realized += real
    total_unrealized += unreal
    open_value += os_ * lpx

print(f"\n  --- TOTALS ---")
print(f"  Realized P&L (from SELL fills):     ${total_realized:.4f}")
print(f"  Unrealized (last fill px estimate):  ${total_unrealized:.4f}")
print(f"  Open position value (open_sh*lastpx):${open_value:.4f}")
print(f"  Total P&L estimate:                  ${total_realized+total_unrealized:.4f}")
print(f"")
print(f"  Cash deployed (buys-sells):          ${buys[1]-sells[1]:.4f}")
print(f"  Remaining value of held positions:   ${open_value:.4f}")
print(f"  Simple P&L (received+held-paid):     ${sells[1]+open_value-buys[1]:.4f}")

print(f"\n=== RUNTIME METRICS ===")
metrics = c.execute("SELECT profileId, key, value FROM RuntimeMetric WHERE profileId=?", (PROFILE,)).fetchall()
for m in metrics:
    print(f"  [{m[0]}] {m[1]} = {m[2]}")
all_metrics = c.execute("SELECT profileId, key, value FROM RuntimeMetric").fetchall()
for m in all_metrics:
    print(f"  [{m[0]}] {m[1]} = {m[2]}")

print(f"\n=== COPY INTENT STATS ===")
intents = c.execute("""
  SELECT status, COUNT(*), reason
  FROM CopyIntent WHERE profileId=?
  GROUP BY status, reason
  ORDER BY COUNT(*) DESC
""", (PROFILE,)).fetchall()
for row in intents:
    print(f"  status={row[0]:12} count={row[1]:4d}  reason={row[2]}")

print(f"\n=== LEADER2 FILLS (for comparison) ===")
lb = c.execute("""
  SELECT COUNT(*), SUM(f.price*f.size), SUM(f.size)
  FROM Fill f JOIN [Order] o ON f.orderId = o.id
  WHERE o.profileId='leader2' AND o.side='BUY'
""").fetchone()
ls = c.execute("""
  SELECT COUNT(*), SUM(f.price*f.size), SUM(f.size)
  FROM Fill f JOIN [Order] o ON f.orderId = o.id
  WHERE o.profileId='leader2' AND o.side='SELL'
""").fetchone()
print(f"  Leader BUY fills:  {lb[0]:3d}  notional=${lb[1]:.4f}  shares={lb[2]:.4f}")
print(f"  Leader SELL fills: {ls[0]:3d}  notional=${ls[1]:.4f}  shares={ls[2]:.4f}")
print(f"  Leader net deployed: ${lb[1]-ls[1]:.4f}")

print(f"\n=== PRICE SLIPPAGE (our fills vs leader event price) ===")
slip_rows = c.execute("""
  SELECT o.side, le.price as leaderPx, f.price as ourPx, (f.price-le.price) as slip
  FROM Fill f
  JOIN [Order] o ON f.orderId = o.id
  JOIN CopyIntent ci ON o.intentId = ci.id
  JOIN LeaderEvent le ON ci.leaderEventId = le.id
  WHERE o.profileId=?
  ORDER BY o.side, slip DESC
""", (PROFILE,)).fetchall()
if slip_rows:
    buy_slips = [r[3] for r in slip_rows if r[0]=='BUY']
    sell_slips = [r[3] for r in slip_rows if r[0]=='SELL']
    if buy_slips:
        print(f"  BUY slippage:  avg={sum(buy_slips)/len(buy_slips):.5f}  min={min(buy_slips):.5f}  max={max(buy_slips):.5f}  n={len(buy_slips)}")
    if sell_slips:
        print(f"  SELL slippage: avg={sum(sell_slips)/len(sell_slips):.5f}  min={min(sell_slips):.5f}  max={max(sell_slips):.5f}  n={len(sell_slips)}")
    # Show worst slippage trades
    print(f"  Worst 5 BUY slippage: {sorted(buy_slips, reverse=True)[:5]}")

print(f"\n=== TIME LAG (ms from leader event to our fill) ===")
lag_rows = c.execute("""
  SELECT o.side, (f.ts - le.ts) as lag_ms
  FROM Fill f
  JOIN [Order] o ON f.orderId = o.id
  JOIN CopyIntent ci ON o.intentId = ci.id
  JOIN LeaderEvent le ON ci.leaderEventId = le.id
  WHERE o.profileId=?
  ORDER BY o.side
""", (PROFILE,)).fetchall()
if lag_rows:
    for side in ('BUY', 'SELL'):
        lags = [r[1] for r in lag_rows if r[0]==side and r[1] is not None]
        if lags:
            print(f"  {side} lag: avg={sum(lags)/len(lags):.0f}ms  min={min(lags)}ms  max={max(lags)}ms  n={len(lags)}")
