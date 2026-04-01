import sqlite3, json
from datetime import datetime, timezone

src = sqlite3.connect("file:packages/db/prisma/dev.db?mode=ro&immutable=1", uri=True)
m = sqlite3.connect(":memory:")
src.backup(m); src.close()
m.row_factory = sqlite3.Row
c = m.cursor()

print("=== RUNTIME STATE ===")
c.execute("SELECT json FROM ConfigVersion WHERE active=1 ORDER BY createdAt DESC LIMIT 1")
cfg = json.loads(c.fetchone()["json"])
print(f"  paused={cfg['safety']['paused']}  killSwitch={cfg['safety']['killSwitch']}")

for key in ["bot.cash_usdc", "bot.drawdown_usdc", "bot.live_starting_usdc", "bot.live_mode_started_at"]:
    c.execute("SELECT value, updatedAt FROM RuntimeMetric WHERE key=? ORDER BY updatedAt DESC LIMIT 1", (key,))
    r = c.fetchone()
    print(f"  {key}: {r['value'] if r else 'NOT SET'}")

print()
print("=== LAST 20 ALERTS ===")
c.execute("SELECT ts, severity, code, message, contextJson FROM Alert ORDER BY ts DESC LIMIT 20")
for r in c.fetchall():
    ts = datetime.fromtimestamp(r["ts"] / 1000, tz=timezone.utc).strftime("%H:%M:%S")
    ctx = json.loads(r["contextJson"]) if r["contextJson"] else {}
    extra = ""
    if r["code"] == "DAILY_DRAWDOWN_STOP":
        extra = f" drawdown=${ctx.get('drawdownUSDC')} limit=${ctx.get('maxDailyDrawdownUSDC')}"
    elif r["code"] == "POSITIONS_SYNCED":
        extra = f" zeroed={ctx.get('count')} sample={str(ctx.get('sample',''))[:60]}"
    elif r["code"] == "RUNTIME_CONTROL_UPDATED":
        extra = f" src={ctx.get('source')} reason={ctx.get('reason','')[:50]}"
    print(f"  [{r['severity']}] {ts} {r['code']}{extra}")

print()
print("=== DB POSITIONS (size > 0) ===")
c.execute("SELECT tokenId, size, avgPrice, updatedAt FROM Position WHERE profileId='default' AND size > 0.001 ORDER BY updatedAt DESC")
rows = c.fetchall()
now = datetime.now(tz=timezone.utc)
print(f"  Count: {len(rows)}")
for r in rows:
    upd = datetime.fromisoformat(str(r["updatedAt"]).replace(" ", "T").rstrip("Z") + "+00:00") if "+" not in str(r["updatedAt"]) else datetime.fromisoformat(str(r["updatedAt"]))
    age_min = (now - upd.replace(tzinfo=timezone.utc) if upd.tzinfo is None else now - upd).total_seconds() / 60
    print(f"  {str(r['tokenId'])[:22]}  sz={float(r['size']):.4f}  avgPx={float(r['avgPrice']):.4f}  age={age_min:.1f}min")

print()
print("=== FILLS (last 15) ===")
c.execute("""
    SELECT ci.side, ci.tokenId, f.price, f.size, f.ts
    FROM Fill f
    JOIN [Order] o ON o.id = f.orderId
    JOIN CopyIntent ci ON ci.id = o.intentId
    WHERE ci.profileId = 'default'
    ORDER BY f.ts DESC LIMIT 15
""")
for r in c.fetchall():
    ts_val = r["ts"]
    if isinstance(ts_val, str):
        ts_str = ts_val[:19]
    else:
        ts_str = datetime.fromtimestamp(ts_val / 1000, tz=timezone.utc).strftime("%H:%M:%S")
    print(f"  {r['side']}  {str(r['tokenId'])[:22]}  px={r['price']:.4f}  sz={r['size']:.4f}  {ts_str}")
