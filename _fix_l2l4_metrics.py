"""
Fix dashboard KPI display for leader2 and leader4:
1. Upsert bot.live_starting_usdc = 25 for both (PAPER bots never write this,
   so it persists across restarts and stops the fallback to $50 default).
2. Reset leader2 bot.cash_usdc / drawdown to 25/0 so dashboard is accurate
   until the worker restarts and re-hydrates from clean DB.
3. Patch leader4 ConfigVersion to include startingUSDC=25 in budget JSON.
"""
import sqlite3, json
from datetime import datetime, timezone

DB = "packages/db/prisma/dev.db"
c = sqlite3.connect(DB)
c.execute("PRAGMA foreign_keys = ON")

now_ms = int(datetime.now(tz=timezone.utc).timestamp() * 1000)

now_iso = datetime.now(tz=timezone.utc).isoformat()

def upsert_metric(profile, key, value):
    existing = c.execute(
        "SELECT 1 FROM RuntimeMetric WHERE profileId=? AND key=?", (profile, key)
    ).fetchone()
    if existing:
        c.execute(
            "UPDATE RuntimeMetric SET value=?, updatedAt=? WHERE profileId=? AND key=?",
            (str(value), now_iso, profile, key)
        )
        print(f"  UPDATED  {profile} | {key} = {value}")
    else:
        c.execute(
            "INSERT INTO RuntimeMetric (profileId, key, value, updatedAt) VALUES (?,?,?,?)",
            (profile, key, str(value), now_iso)
        )
        print(f"  INSERTED {profile} | {key} = {value}")

with c:
    # Fix Starting Balance display for both profiles
    upsert_metric("leader2", "bot.live_starting_usdc", 25)
    upsert_metric("leader4", "bot.live_starting_usdc", 25)

    # Reset leader2 cash/drawdown so dashboard shows correct until bot restarts
    # (the running bot will overwrite these on next heartbeat, but restart will
    #  re-hydrate from empty DB → cash=25, drawdown=0 permanently)
    upsert_metric("leader2", "bot.cash_usdc", 25)
    upsert_metric("leader2", "bot.drawdown_usdc", 0)
    upsert_metric("leader2", "bot.mode", "PAPER")

# Patch leader4 ConfigVersion to add startingUSDC=25 in budget
row = c.execute(
    "SELECT id, json FROM ConfigVersion WHERE profileId='leader4' AND active=1"
).fetchone()
if row:
    cfg = json.loads(row[1])
    if cfg.get("budget", {}).get("startingUSDC") != 25:
        cfg.setdefault("budget", {})["startingUSDC"] = 25
        with c:
            c.execute(
                "UPDATE ConfigVersion SET json=? WHERE id=?",
                (json.dumps(cfg), row[0])
            )
        print(f"\n  PATCHED  leader4 ConfigVersion budget.startingUSDC = 25")
    else:
        print(f"\n  OK       leader4 ConfigVersion budget.startingUSDC already 25")

print()
print("=== Verify ===")
for row in c.execute(
    "SELECT profileId, key, value FROM RuntimeMetric "
    "WHERE profileId IN ('leader2','leader4') AND key IN "
    "('bot.live_starting_usdc','bot.cash_usdc','bot.drawdown_usdc','bot.mode') "
    "ORDER BY profileId, key"
):
    print(f"  {row[0]} | {row[1]} = {row[2]}")

print()
print("✓ DB fixed.")
print()
print("IMPORTANT: Restart the leader2 bot window so it re-hydrates from the")
print("clean DB (0 fills → cash=$25, drawdown=$0, mode=PAPER written on boot).")
c.close()
