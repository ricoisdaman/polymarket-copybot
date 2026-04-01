"""
Wipe leader3 and leader4 paper trading data, then reconfigure leader3
to follow the new esports trader wallet.
"""
import sqlite3, json, uuid
from datetime import datetime, timezone

DB = "packages/db/prisma/dev.db"
NEW_WALLET = "0x25e28169faea17421fcd4cc361f6436d1e449a09"
PROFILES_TO_WIPE = ("leader3", "leader4")

c = sqlite3.connect(DB)
c.row_factory = sqlite3.Row
c.execute("PRAGMA foreign_keys = ON")

def count(table, profile):
    return c.execute(f'SELECT COUNT(*) FROM "{table}" WHERE profileId=?', (profile,)).fetchone()[0]

print("=== Row counts BEFORE deletion ===")
for p in PROFILES_TO_WIPE:
    for t in ['ConfigVersion','LeaderCursor','LeaderEvent','CopyIntent','Fill','Position','Alert','RuntimeMetric']:
        n = count(t, p)
        if n > 0:
            print(f"  {p:10s}  {t:20s}  {n}")

# ── Step 1: find all Order IDs belonging to these profiles ───────────────
# Orders link: Fill → Order → CopyIntent (profileId)
order_ids = [
    r[0] for r in c.execute("""
        SELECT o.id FROM "Order" o
        JOIN CopyIntent ci ON ci.id = o.intentId
        WHERE ci.profileId IN ('leader3','leader4')
    """).fetchall()
]
print(f"\n  Orders to delete: {len(order_ids)}")

# ── Step 2: delete in FK-safe order ──────────────────────────────────────
with c:
    # Fill references Order
    if order_ids:
        placeholders = ",".join("?" * len(order_ids))
        deleted = c.execute(f'DELETE FROM Fill WHERE orderId IN ({placeholders})', order_ids).rowcount
        print(f"  Deleted {deleted} Fill rows")

    # Order references CopyIntent
    if order_ids:
        deleted = c.execute(f'DELETE FROM "Order" WHERE id IN ({placeholders})', order_ids).rowcount
        print(f"  Deleted {deleted} Order rows")

    # CopyIntent references LeaderEvent
    deleted = c.execute("DELETE FROM CopyIntent WHERE profileId IN ('leader3','leader4')").rowcount
    print(f"  Deleted {deleted} CopyIntent rows")

    # LeaderEvent
    deleted = c.execute("DELETE FROM LeaderEvent WHERE profileId IN ('leader3','leader4')").rowcount
    print(f"  Deleted {deleted} LeaderEvent rows")

    # Position
    deleted = c.execute("DELETE FROM Position WHERE profileId IN ('leader3','leader4')").rowcount
    print(f"  Deleted {deleted} Position rows")

    # Alert
    deleted = c.execute("DELETE FROM Alert WHERE profileId IN ('leader3','leader4')").rowcount
    print(f"  Deleted {deleted} Alert rows")

    # RuntimeMetric
    deleted = c.execute("DELETE FROM RuntimeMetric WHERE profileId IN ('leader3','leader4')").rowcount
    print(f"  Deleted {deleted} RuntimeMetric rows")

    # LeaderCursor
    deleted = c.execute("DELETE FROM LeaderCursor WHERE profileId IN ('leader3','leader4')").rowcount
    print(f"  Deleted {deleted} LeaderCursor rows")

    # ConfigVersion
    deleted = c.execute("DELETE FROM ConfigVersion WHERE profileId IN ('leader3','leader4')").rowcount
    print(f"  Deleted {deleted} ConfigVersion rows")

# ── Step 3: insert fresh leader3 config for new esports wallet ───────────
new_config = {
    "mode": "PAPER",
    "leader": {
        "wallet": NEW_WALLET,
        "copyBuys": True,
        "copySells": True,
        "feedMode": "DATA_API_POLL",
        "pollIntervalSeconds": 2,
        "sellFullPositionOnLeaderSell": True
    },
    "budget": {
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
new_id = "cv_leader3_esports_" + datetime.now(tz=timezone.utc).strftime("%Y%m%d%H%M%S")

with c:
    c.execute(
        'INSERT INTO ConfigVersion (id, profileId, createdAt, json, active) VALUES (?,?,?,?,?)',
        (new_id, "leader3", now_iso, json.dumps(new_config), 1)
    )
    print(f"\n  Inserted ConfigVersion id={new_id}  profileId=leader3  wallet={NEW_WALLET}")

    # Fresh LeaderCursor so the bot starts polling from the current activity
    c.execute(
        'INSERT INTO LeaderCursor (profileId, leaderWallet, lastSeenActivityKey, updatedAt) VALUES (?,?,?,?)',
        ("leader3", NEW_WALLET, None, int(datetime.now(tz=timezone.utc).timestamp() * 1000))
    )
    print(f"  Inserted LeaderCursor  profileId=leader3  wallet={NEW_WALLET}")

print("\n=== Row counts AFTER migration ===")
for p in list(PROFILES_TO_WIPE) + ["leader3"]:
    for t in ['ConfigVersion','LeaderCursor','LeaderEvent','CopyIntent','Fill','Position','Alert','RuntimeMetric']:
        n = count(t, p)
        if n > 0 or p == "leader3":
            print(f"  {p:10s}  {t:20s}  {n}")

print("\n✓ Done — leader3 reset, leader4 wiped, new esports wallet configured.")
c.close()
