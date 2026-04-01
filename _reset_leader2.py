"""
Wipe leader2 paper trading data, then re-insert a fresh ConfigVersion
and LeaderCursor for the current active wallet.
"""
import sqlite3, json
from datetime import datetime, timezone

DB = "packages/db/prisma/dev.db"
PROFILE = "leader2"
WALLET  = "0x2a2c53bd278c04da9962fcf96490e17f3dfb9bc1"

c = sqlite3.connect(DB)
c.row_factory = sqlite3.Row
c.execute("PRAGMA foreign_keys = ON")

def count(table, profile):
    return c.execute(f'SELECT COUNT(*) FROM "{table}" WHERE profileId=?', (profile,)).fetchone()[0]

print("=== Row counts BEFORE deletion ===")
for t in ['ConfigVersion','LeaderCursor','LeaderEvent','CopyIntent','Fill','Position','Alert','RuntimeMetric']:
    n = count(t, PROFILE)
    if n > 0:
        print(f"  {PROFILE:10s}  {t:20s}  {n}")

# ── Step 1: find all Order IDs belonging to leader2 ──────────────────────
order_ids = [
    r[0] for r in c.execute("""
        SELECT o.id FROM "Order" o
        JOIN CopyIntent ci ON ci.id = o.intentId
        WHERE ci.profileId = ?
    """, (PROFILE,)).fetchall()
]
print(f"\n  Orders to delete: {len(order_ids)}")

# ── Step 2: delete in FK-safe order ──────────────────────────────────────
with c:
    if order_ids:
        placeholders = ",".join("?" * len(order_ids))
        deleted = c.execute(f'DELETE FROM Fill WHERE orderId IN ({placeholders})', order_ids).rowcount
        print(f"  Deleted {deleted} Fill rows")

        deleted = c.execute(f'DELETE FROM "Order" WHERE id IN ({placeholders})', order_ids).rowcount
        print(f"  Deleted {deleted} Order rows")

    deleted = c.execute("DELETE FROM CopyIntent WHERE profileId = ?", (PROFILE,)).rowcount
    print(f"  Deleted {deleted} CopyIntent rows")

    deleted = c.execute("DELETE FROM LeaderEvent WHERE profileId = ?", (PROFILE,)).rowcount
    print(f"  Deleted {deleted} LeaderEvent rows")

    deleted = c.execute("DELETE FROM Position WHERE profileId = ?", (PROFILE,)).rowcount
    print(f"  Deleted {deleted} Position rows")

    deleted = c.execute("DELETE FROM Alert WHERE profileId = ?", (PROFILE,)).rowcount
    print(f"  Deleted {deleted} Alert rows")

    deleted = c.execute("DELETE FROM RuntimeMetric WHERE profileId = ?", (PROFILE,)).rowcount
    print(f"  Deleted {deleted} RuntimeMetric rows")

    deleted = c.execute("DELETE FROM LeaderCursor WHERE profileId = ?", (PROFILE,)).rowcount
    print(f"  Deleted {deleted} LeaderCursor rows")

    deleted = c.execute("DELETE FROM ConfigVersion WHERE profileId = ?", (PROFILE,)).rowcount
    print(f"  Deleted {deleted} ConfigVersion rows")

# ── Step 3: insert fresh config for current wallet ───────────────────────
new_config = {
    "mode": "PAPER",
    "leader": {
        "wallet": WALLET,
        "copyBuys": True,
        "copySells": True,
        "feedMode": "DATA_API_POLL",
        "pollIntervalSeconds": 2,
        "sellFullPositionOnLeaderSell": True
    },
    "budget": {
        "startingUSDC": 25,
        "reserveUSDC": 5,
        "safetyBufferUSDC": 0.25,
        "perTradeNotionalUSDC": 5,
        "minTradeNotionalUSDC": 0.5,
        "maxTradeNotionalUSDC": 6,
        "maxNotionalPerMarketUSDC": 5,
        "maxOpenMarkets": 100,
        "maxDailyNotionalUSDC": 1000,
        "maxDailyDrawdownUSDC": 30
    },
    "execution": {
        "style": "TAKER",
        "heartbeatIntervalSeconds": 5,
        "maxTradesPerMinute": 10,
        "maxSpreadBps": 1500,
        "maxSlippageBps": 50,
        "maxChaseSeconds": 8,
        "maxRetries": 2,
        "acceptPartialFillAndStop": True,
        "minOrderNotionalUSDC": 1,
        "minOrderShares": 5,
        "strictVenueConstraintsInPaper": True,
        "maxEventAgeMs": 30000,
        "maxLeaderToSubmitMs": 3000,
        "topOfBookDepthMultiple": 3,
        "takeProfitBps": 0,
        "minMarketAgeRemainingMs": 0
    },
    "safety": {
        "killSwitch": False,
        "paused": False,
        "pauseOnErrorStorm": True,
        "botHeartbeatStaleSeconds": 120,
        "errorStorm": {
            "maxErrors": 10,
            "windowSeconds": 60,
            "pauseSeconds": 120
        },
        "reconcileIntervalSeconds": 30,
        "wsStaleSeconds": 10,
        "reconnectBackfillSeconds": 120,
        "confirmBackfillSeconds": 90
    },
    "filters": {
        "minPrice": 0.55,
        "maxPrice": 0.9999,
        "blacklistConditionIds": [],
        "blacklistTokenIds": [],
        "blockedTitleKeywords": [],
        "excludeFeeEnabledMarkets": True,
        "excludeLowLiquidityMarkets": True
    }
}

now_iso = datetime.now(tz=timezone.utc).isoformat()
new_id = "cv_leader2_reset_" + datetime.now(tz=timezone.utc).strftime("%Y%m%d%H%M%S")

with c:
    c.execute(
        'INSERT INTO ConfigVersion (id, profileId, createdAt, json, active) VALUES (?,?,?,?,?)',
        (new_id, PROFILE, now_iso, json.dumps(new_config), 1)
    )
    print(f"\n  Inserted ConfigVersion id={new_id}  profileId={PROFILE}  wallet={WALLET}")

    c.execute(
        'INSERT INTO LeaderCursor (profileId, leaderWallet, lastSeenActivityKey, updatedAt) VALUES (?,?,?,?)',
        (PROFILE, WALLET, None, int(datetime.now(tz=timezone.utc).timestamp() * 1000))
    )
    print(f"  Inserted LeaderCursor  profileId={PROFILE}  wallet={WALLET}")

print("\n=== Row counts AFTER reset ===")
for t in ['ConfigVersion','LeaderCursor','LeaderEvent','CopyIntent','Fill','Position','Alert','RuntimeMetric']:
    n = count(t, PROFILE)
    print(f"  {PROFILE:10s}  {t:20s}  {n}")

print(f"\n✓ Done — leader2 wiped and reset to wallet {WALLET}")
c.close()
