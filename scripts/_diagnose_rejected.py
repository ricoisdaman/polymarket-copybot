import sqlite3, json
from datetime import datetime
db = sqlite3.connect('packages/db/prisma/dev.db')
db.row_factory = sqlite3.Row

# 1. The REJECTED intent details
print('=== REJECTED intents (LIVE_ORDER_NOT_FILLED) ===')
rows = db.execute("""
    SELECT ci.id, ci.ts, ci.side, ci.status, ci.reason, ci.desiredNotional, ci.desiredSize, ci.leaderEventId,
           le.price as leaderPrice, le.usdcSize, le.rawJson, le.conditionId, le.tokenId
    FROM CopyIntent ci JOIN LeaderEvent le ON ci.leaderEventId = le.id
    WHERE ci.profileId='live' AND ci.reason='LIVE_ORDER_NOT_FILLED'
    ORDER BY ci.ts DESC LIMIT 3
""").fetchall()
for r in rows:
    rj = json.loads(r['rawJson']) if r['rawJson'] else {}
    title = rj.get('title', rj.get('question', '?'))[:70]
    print(f"  ts={r['ts']}")
    print(f"  desiredSize={r['desiredSize']}  desiredNotional={r['desiredNotional']}")
    print(f"  leaderPrice={r['leaderPrice']}  leaderUSDC={r['usdcSize']}")
    print(f"  title={title}")
    print()

# 2. What config is the live bot actually running from ConfigVersion?
print('=== ConfigVersion active for live ===')
rows2 = db.execute("""
    SELECT json, createdAt FROM ConfigVersion WHERE profileId='live' ORDER BY createdAt DESC LIMIT 1
""").fetchall()
if rows2:
    cfg = json.loads(rows2[0]['json'])
    bud = cfg.get('budget', {})
    exe = cfg.get('execution', {})
    flt = cfg.get('filters', {})
    print(f"  perTradeNotionalUSDC = {bud.get('perTradeNotionalUSDC')}")
    print(f"  maxTradeNotionalUSDC = {bud.get('maxTradeNotionalUSDC')}")
    print(f"  maxNotionalPerMarket = {bud.get('maxNotionalPerMarketUSDC')}")
    print(f"  reserveUSDC          = {bud.get('reserveUSDC')}")
    print(f"  minOrderShares       = {exe.get('minOrderShares')}")
    print(f"  minOrderNotionalUSDC = {exe.get('minOrderNotionalUSDC')}")
    print(f"  maxSlippageBps       = {exe.get('maxSlippageBps')}")
    print(f"  maxChaseSeconds      = {exe.get('maxChaseSeconds')}")
    print(f"  minPrice filter      = {flt.get('minPrice')}")
    print(f"  createdAt            = {rows2[0]['createdAt']}")
else:
    print("  No ConfigVersion found for live profile")

# 3. Orders placed for live profile
print()
print('=== Orders for live profile ===')
rows3 = db.execute("""
    SELECT o.ts, o.side, o.price, o.size, o.status, o.clobOrderId
    FROM "Order" o JOIN CopyIntent ci ON o.intentId = ci.id
    WHERE ci.profileId='live'
    ORDER BY o.ts DESC LIMIT 10
""").fetchall()
if not rows3:
    print("  No orders found")
else:
    for r in rows3:
        print(f"  {r['ts']}  price={r['price']}  size={r['size']}  status={r['status']}  clob={r['clobOrderId']}")

# 4. Skip reason breakdown after restart (last 200 intents)
print()
print('=== Skip reason breakdown (all live intents) ===')
rows4 = db.execute("""
    SELECT reason, mode, COUNT(*) as cnt FROM CopyIntent
    WHERE profileId='live'
    GROUP BY reason, mode ORDER BY cnt DESC
""").fetchall()
for r in rows4:
    print(f"  {(r['reason'] or 'FILLED'):35}  {r['cnt']:5}  mode={r['mode']}")

db.close()
