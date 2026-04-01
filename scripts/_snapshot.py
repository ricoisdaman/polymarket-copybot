"""Full DB state check — all profiles, all tables."""
import sqlite3

DB = "packages/db/prisma/dev.db"
conn = sqlite3.connect(DB)
cur = conn.cursor()

# All profileIds in any table
cur.execute("SELECT DISTINCT profileId FROM CopyIntent ORDER BY profileId")
profiles_from_intents = [r[0] for r in cur.fetchall()]

cur.execute("SELECT DISTINCT profileId FROM RuntimeMetric ORDER BY profileId")
profiles_from_metrics = [r[0] for r in cur.fetchall()]

cur.execute("SELECT DISTINCT profileId FROM Position ORDER BY profileId")
profiles_from_positions = [r[0] for r in cur.fetchall()]

print("Profiles with CopyIntents:", profiles_from_intents)
print("Profiles with Metrics:    ", profiles_from_metrics)
print("Profiles with Positions:  ", profiles_from_positions)
print()

all_profiles = sorted(set(profiles_from_intents + profiles_from_metrics + profiles_from_positions))
for profile in all_profiles:
    print(f"=== {profile} ===")
    cur.execute("SELECT COUNT(*), MIN(ts), MAX(ts) FROM CopyIntent WHERE profileId=?", (profile,))
    r = cur.fetchone()
    print(f"  Intents: {r[0]}  from {r[1]} to {r[2]}")
    cur.execute("""
        SELECT i.side, COUNT(*), SUM(f.price*f.size)
        FROM Fill f JOIN [Order] o ON f.orderId=o.id JOIN CopyIntent i ON o.intentId=i.id
        WHERE i.profileId=? GROUP BY i.side
    """, (profile,))
    for row in cur.fetchall():
        print(f"  Fills {row[0]}: count={row[1]} notional=${row[2]:.2f}")
    cur.execute("SELECT key, value FROM RuntimeMetric WHERE profileId=?", (profile,))
    for row in cur.fetchall():
        print(f"  Metric {row[0]} = {row[1]}")
    print()
