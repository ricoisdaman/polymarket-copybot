"""
Diagnose: why 0 trades on live + paper bots since beta launch
Checks: skip reasons, slug breakdown, heartbeats, feed health, non-tennis pass-throughs
"""
import sqlite3, os, json
from datetime import datetime, timedelta, timezone

DB = os.path.join(os.path.dirname(__file__), "packages", "db", "prisma", "dev.db")
if not os.path.exists(DB):
    print(f"ERROR: DB not found at {DB}"); exit(1)

con = sqlite3.connect(DB)
con.row_factory = sqlite3.Row
c = con.cursor()

now = datetime.now(timezone.utc)
since_24h = (now - timedelta(hours=24)).isoformat()
since_8h  = (now - timedelta(hours=8)).isoformat()
since_48h = (now - timedelta(hours=48)).isoformat()

print("=" * 60)
print(f"  Diagnostic run at {now.strftime('%Y-%m-%d %H:%M UTC')}")
print("=" * 60)

# ── 1. Skip reason breakdown per profile (last 24h) ─────────────────
print("\n[1] SKIP REASONS per profile (last 24h)\n")
c.execute("""
    SELECT profileId, reason, COUNT(*) as cnt
    FROM CopyIntent
    WHERE status = 'SKIPPED' AND ts >= ?
    GROUP BY profileId, reason
    ORDER BY profileId, cnt DESC
""", (since_24h,))
rows = c.fetchall()
if not rows:
    print("  (no skipped intents in last 24h — bot may not be polling)")
else:
    fmt = "{:<16} {:<30} {:>5}"
    print(fmt.format("profileId", "reason", "cnt"))
    print("-" * 55)
    for r in rows:
        print(fmt.format(r["profileId"], r["reason"] or "(null)", r["cnt"]))

# ── 2. Actual trades per profile (last 24h) ─────────────────────────
print("\n[2] ACTUAL TRADES per profile (last 24h)\n")
c.execute("""
    SELECT profileId, status, COUNT(*) as cnt
    FROM CopyIntent
    WHERE status NOT IN ('SKIPPED','PENDING') AND ts >= ?
    GROUP BY profileId, status
    ORDER BY profileId, cnt DESC
""", (since_24h,))
rows = c.fetchall()
if not rows:
    print("  *** ZERO TRADES across all profiles in last 24h ***")
else:
    fmt = "{:<16} {:<30} {:>5}"
    print(fmt.format("profileId", "status", "cnt"))
    print("-" * 55)
    for r in rows:
        print(fmt.format(r["profileId"], r["status"], r["cnt"]))

# ── 3. Total leader events seen (last 24h) ──────────────────────────
print("\n[3] LEADER EVENTS seen per profile (last 24h)\n")
c.execute("""
    SELECT profileId, COUNT(*) as cnt
    FROM CopyIntent
    WHERE ts >= ?
    GROUP BY profileId
    ORDER BY profileId
""", (since_24h,))
rows = c.fetchall()
if not rows:
    print("  (no CopyIntents at all — feed may be down or bot not running)")
else:
    fmt = "{:<16} {:>8}"
    print(fmt.format("profileId", "events"))
    print("-" * 28)
    for r in rows:
        print(fmt.format(r["profileId"], r["cnt"]))

# ── 4. Slug breakdown for SLUG_BLOCKED on live (last 24h) ───────────
print("\n[4] SLUG_BLOCKED slugs on 'live' profile (last 24h, top 25)\n")
c.execute("""
    SELECT le.rawJson, COUNT(*) as cnt
    FROM CopyIntent ci
    JOIN LeaderEvent le ON le.id = ci.leaderEventId
    WHERE ci.profileId = 'live'
      AND ci.reason = 'SLUG_BLOCKED'
      AND ci.ts >= ?
    GROUP BY le.rawJson
    ORDER BY cnt DESC
    LIMIT 25
""", (since_24h,))
rows = c.fetchall()
if not rows:
    print("  (no SLUG_BLOCKED on live in last 24h)")
else:
    print(f"  {'slug':<50} {'cnt':>5}")
    print("  " + "-" * 58)
    for r in rows:
        try:
            raw = json.loads(r["rawJson"])
            slug = raw.get("slug") or raw.get("eventSlug") or "(no slug)"
        except:
            slug = "(parse error)"
        print(f"  {slug[:50]:<50} {r['cnt']:>5}")

# ── 5. NON-TENNIS slugs that were SLUG_BLOCKED (would be a bug) ──────
print("\n[5] NON-TENNIS slugs caught by SLUG_BLOCKED on 'live' (last 24h)\n")
c.execute("""
    SELECT le.rawJson, ci.profileId, COUNT(*) as cnt
    FROM CopyIntent ci
    JOIN LeaderEvent le ON le.id = ci.leaderEventId
    WHERE ci.reason = 'SLUG_BLOCKED'
      AND ci.ts >= ?
    GROUP BY le.rawJson, ci.profileId
    ORDER BY cnt DESC
    LIMIT 50
""", (since_24h,))
rows = c.fetchall()
non_tennis = []
for r in rows:
    try:
        raw = json.loads(r["rawJson"])
        slug = (raw.get("slug") or raw.get("eventSlug") or "").lower()
    except:
        slug = ""
    # tennis prefixes that we intentionally block
    is_tennis = any(slug.startswith(p) for p in ["atp-", "wta-", "tennis-"])
    if not is_tennis:
        non_tennis.append((r["profileId"], slug[:55], r["cnt"]))

if not non_tennis:
    print("  ✓ All SLUG_BLOCKED intents are legitimate tennis slugs (no regression)")
else:
    print("  !! UNEXPECTED NON-TENNIS SLUGS BLOCKED !!")
    fmt = "{:<16} {:<55} {:>5}"
    print(fmt.format("profileId", "slug", "cnt"))
    print("-" * 80)
    for row in non_tennis:
        print(fmt.format(*row))

# ── 6. Bot heartbeats (are bots actually running?) ───────────────────
print("\n[6] BOT HEARTBEATS (last 30 min)\n")
since_30m = (now - timedelta(minutes=30)).isoformat()
c.execute("""
    SELECT * FROM RuntimeMetric
    WHERE key = 'bot.heartbeat'
    ORDER BY updatedAt DESC
""")
rows = c.fetchall()
if not rows:
    print("  (no heartbeat metrics found — RuntimeMetric table may be empty)")
else:
    fmt = "{:<16} {:<22} {:>12}"
    print(fmt.format("profileId", "updatedAt", "age_min"))
    print("-" * 54)
    for r in rows:
        try:
            updated = datetime.fromisoformat(str(r["updatedAt"]).replace("Z", "+00:00"))
            if updated.tzinfo is None:
                updated = updated.replace(tzinfo=timezone.utc)
            age_min = (now - updated).total_seconds() / 60
            flag = " *** STALE" if age_min > 10 else ""
            print(fmt.format(r["profileId"], str(r["updatedAt"])[:19], f"{age_min:.1f}") + flag)
        except Exception as e:
            print(f"  {r['profileId']}: (parse error: {e})")

# ── 7. Recent alerts / errors ─────────────────────────────────────────
print("\n[7] RECENT ALERTS / ERRORS (last 24h)\n")
try:
    c.execute("""
        SELECT profileId, code, message, ts
        FROM Alert
        WHERE ts >= ?
        ORDER BY ts DESC
        LIMIT 20
    """, (since_24h,))
    rows = c.fetchall()
    if not rows:
        print("  (no alerts in last 24h)")
    else:
        for r in rows:
            print(f"  [{r['ts'][:19]}] {r['profileId']} | {r['code']} | {r['message'][:80]}")
except sqlite3.OperationalError as e:
    print(f"  (Alert table not accessible: {e})")

# ── 8. Recent non-SLUG intents on live (other skip reasons / passes) ─
print("\n[8] NON-SLUG_BLOCKED intents on 'live' (last 24h)\n")
c.execute("""
    SELECT ci.status, ci.reason, ci.side, le.price, le.rawJson, ci.ts
    FROM CopyIntent ci
    LEFT JOIN LeaderEvent le ON le.id = ci.leaderEventId
    WHERE ci.profileId = 'live'
      AND (ci.reason != 'SLUG_BLOCKED' OR ci.reason IS NULL)
      AND ci.ts >= ?
    ORDER BY ci.ts DESC
    LIMIT 30
""", (since_24h,))
rows = c.fetchall()
if not rows:
    print("  (all intents on live were SLUG_BLOCKED or none at all)")
else:
    fmt = "{:<10} {:<10} {:<22} {:>5} {:<40}"
    print(fmt.format("status", "reason", "ts", "price", "slug"))
    print("-" * 90)
    for r in rows:
        try:
            raw = json.loads(r["rawJson"] or "{}")
            slug = (raw.get("slug") or raw.get("eventSlug") or "")[:40]
        except:
            slug = "(err)"
        ts = str(r["ts"])[:19]
        print(fmt.format(r["status"] or "", r["reason"] or "", ts, str(r["price"] or ""), slug))

# ── 9. Check if paper-v2 / other profiles have any intents ──────────
print("\n[9] ALL PROFILE INTENT COUNTS (last 48h)\n")
c.execute("""
    SELECT profileId, status, COUNT(*) as cnt
    FROM CopyIntent
    WHERE ts >= ?
    GROUP BY profileId, status
    ORDER BY profileId, cnt DESC
""", (since_48h,))
rows = c.fetchall()
if not rows:
    print("  (no intents in last 48h — all bots may be stopped)")
else:
    fmt = "{:<16} {:<30} {:>6}"
    print(fmt.format("profileId", "status", "cnt"))
    print("-" * 56)
    for r in rows:
        print(fmt.format(r["profileId"], r["status"], r["cnt"]))

# ── 10. ConfigVersion — what filters are active? ────────────────────
print("\n[10] ACTIVE CONFIG VERSIONS (filter summary)\n")
c.execute("""
    SELECT cv.profileId, cv.version, cv.createdAt, cv.config
    FROM ConfigVersion cv
    WHERE cv.isActive = 1
    ORDER BY cv.profileId
""")
rows = c.fetchall()
if not rows:
    print("  (no active config versions)")
else:
    for r in rows:
        try:
            cfg = json.loads(r["config"])
            f = cfg.get("filters", {})
            print(f"  Profile: {r['profileId']} (v{r['version']}, {str(r['createdAt'])[:19]})")
            print(f"    minPrice: {f.get('minPrice')}  maxPrice: {f.get('maxPrice')}")
            print(f"    blockedSlugPrefixes: {f.get('blockedSlugPrefixes')}")
            print(f"    sportPriceFilters: {f.get('sportPriceFilters')}")
            print()
        except Exception as e:
            print(f"  {r['profileId']}: config parse error: {e}")

con.close()
print("=" * 60)
print("  Diagnostic complete")
print("=" * 60)
