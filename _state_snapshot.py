import sqlite3, json
from datetime import datetime, timezone

DB = "packages/db/prisma/dev.db"
c = sqlite3.connect(DB)
c.row_factory = sqlite3.Row

def ts(ms):
    return datetime.fromtimestamp(ms/1000, tz=timezone.utc).strftime("%m-%d %H:%M UTC")

print("=" * 70)
print("  BOT STATE SNAPSHOT")
print("=" * 70)

# ── Runtime metrics ──────────────────────────────────────────────────────
print("\n── Runtime Metrics ──")
metrics = {r["key"]: r for r in c.execute(
    "SELECT key, value, updatedAt FROM RuntimeMetric WHERE profileId='live' ORDER BY key"
).fetchall()}
for key, row in metrics.items():
    print(f"  {key:50s}  {str(row['value']):<25s}  @{ts(int(row['updatedAt']))}")

# ── Current open positions ───────────────────────────────────────────────
print("\n── Open Positions ──")
pos = c.execute("""
    SELECT p.tokenId, p.size, p.avgPrice, p.size*p.avgPrice as cost,
           json_extract(le.rawJson,'$.title') as title
    FROM Position p
    LEFT JOIN CopyIntent ci ON ci.tokenId=p.tokenId AND ci.profileId=p.profileId
    LEFT JOIN LeaderEvent le ON le.id=ci.leaderEventId
    WHERE p.profileId='live' AND p.size > 0
    GROUP BY p.tokenId
""").fetchall()
print(f"  count={len(pos)}")
for p in pos:
    print(f"  size={p['size']:.4f}  avgPrice={p['avgPrice']:.4f}  cost=${p['cost']:.4f}  {str(p['title'] or p['tokenId'])[:60]}")

# ── Recent fills ─────────────────────────────────────────────────────────
print("\n── Recent Fills (last 20) ──")
fills = c.execute("""
    SELECT f.ts, f.price, f.price*f.size as usdc, f.size, o.side,
           json_extract(le.rawJson,'$.title') as title
    FROM Fill f
    JOIN "Order" o ON o.id=f.orderId
    JOIN CopyIntent ci ON ci.id=o.intentId
    JOIN LeaderEvent le ON le.id=ci.leaderEventId
    WHERE f.profileId='live'
    ORDER BY f.ts DESC LIMIT 20
""").fetchall()
for f in fills:
    print(f"  {ts(f['ts'])}  {f['side']:4s}  ${f['price']:.4f}  ${f['usdc']:.4f}  {str(f['title'] or '')[:55]}")

# ── All alerts (newest first) ─────────────────────────────────────────────
print("\n── Alerts (newest 30) ──")
alerts = c.execute(
    "SELECT ts, severity, code, message, contextJson FROM Alert WHERE profileId='live' ORDER BY ts DESC LIMIT 30"
).fetchall()
for a in alerts:
    ctx = json.loads(a['contextJson']) if a['contextJson'] else {}
    ctx_str = json.dumps(ctx)[:120]
    print(f"  {ts(a['ts'])}  {a['severity']:4s}  {str(a['code'] or ''):30s}  {ctx_str}")

# ── Copy intent skip breakdown ────────────────────────────────────────────
print("\n── Skip Reason Breakdown (all time) ──")
for row in c.execute("""
    SELECT reason, COUNT(*) as n FROM CopyIntent
    WHERE profileId='live' GROUP BY reason ORDER BY n DESC
""").fetchall():
    print(f"  {str(row['reason'] or 'NULL'):40s}  {row['n']}")

# ── Recent PAUSED skips ───────────────────────────────────────────────────
print("\n── PAUSED Skips (newest 20) ──")
paused = c.execute("""
    SELECT ci.ts, le.side, le.price, json_extract(le.rawJson,'$.title') as title
    FROM CopyIntent ci
    JOIN LeaderEvent le ON le.id=ci.leaderEventId
    WHERE ci.profileId='live' AND ci.reason='PAUSED'
    ORDER BY ci.ts DESC LIMIT 20
""").fetchall()
print(f"  count={len(paused)}")
for p in paused:
    print(f"  {ts(p['ts'])}  {p['side']:3s}  price={p['price']}  {str(p['title'] or '')[:60]}")

# ── Orders in non-terminal state ──────────────────────────────────────────
print("\n── Open/Pending Orders ──")
orders = c.execute("""
    SELECT o.ts, o.status, o.side, o.price, o.size,
           json_extract(le.rawJson,'$.title') as title
    FROM "Order" o
    JOIN CopyIntent ci ON ci.id=o.intentId
    JOIN LeaderEvent le ON le.id=ci.leaderEventId
    WHERE o.profileId='live' AND o.status NOT IN ('FILLED','CANCELLED','EXPIRED')
    ORDER BY o.ts DESC LIMIT 10
""").fetchall()
print(f"  count={len(orders)}")
for o in orders:
    print(f"  {ts(o['ts'])}  {o['status']:12s}  {o['side']:4s}  ${o['price']:.4f}  {str(o['title'] or '')[:50]}")

# ── Daily notional ────────────────────────────────────────────────────────
print("\n── Daily Notional (fills in last 24h) ──")
cutoff = datetime.now(tz=timezone.utc).timestamp() * 1000 - 86400000
fills_24h = c.execute("""
    SELECT f.ts, f.price*f.size as usdc, json_extract(le.rawJson,'$.title') as title
    FROM Fill f
    JOIN "Order" o ON o.id=f.orderId
    JOIN CopyIntent ci ON ci.id=o.intentId
    JOIN LeaderEvent le ON le.id=ci.leaderEventId
    WHERE f.profileId='live' AND f.ts > ? AND o.side='BUY'
    ORDER BY f.ts ASC
""", (cutoff,)).fetchall()
total_24h = sum(f['usdc'] for f in fills_24h)
print(f"  {len(fills_24h)} fills in last 24h  =  ${total_24h:.4f} notional")
for f in fills_24h:
    print(f"    {ts(f['ts'])}  ${f['usdc']:.4f}  {str(f['title'] or '')[:55]}")

# ── Config ────────────────────────────────────────────────────────────────
print("\n── Active Config ──")
cfg_row = c.execute(
    "SELECT json FROM ConfigVersion WHERE profileId='live' AND active=1"
).fetchone()
if cfg_row:
    cfg = json.loads(cfg_row['json'])
    filters = cfg.get('filters', {})
    limits  = cfg.get('limits', {})
    print(f"  maxPrice={filters.get('maxPrice')}  minPrice={filters.get('minPrice')}")
    print(f"  dailyNotionalLimit=${limits.get('dailyNotionalUSDC')}  maxOpenPositions={limits.get('maxOpenPositions')}")
    print(f"  perTradeNotional=${cfg.get('perTradeNotionalUSDC')}  reserveUSDC=${cfg.get('reserveUSDC')}")
    print(f"  maxChaseSeconds={cfg.get('maxChaseSeconds')}  killSwitchDrawdownUSDC=${cfg.get('killSwitchDrawdownUSDC')}")

c.close()
