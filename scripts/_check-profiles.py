import sqlite3, json

db = sqlite3.connect('packages/db/prisma/dev.db')
db.row_factory = sqlite3.Row

print('=== All distinct profiles in ConfigVersion ===')
rows = db.execute("SELECT DISTINCT profileId FROM ConfigVersion ORDER BY profileId").fetchall()
for r in rows:
    print(f"  {r['profileId']}")

print()
print('=== Latest ConfigVersion per profile (paused/active state) ===')
profiles = [r['profileId'] for r in rows]
for pid in profiles:
    row = db.execute(
        "SELECT active, json, createdAt FROM ConfigVersion WHERE profileId=? ORDER BY createdAt DESC LIMIT 1",
        (pid,)
    ).fetchone()
    if row:
        cfg = json.loads(row['json'])
        safety = cfg.get('safety', {})
        created = str(row['createdAt'])[:19]
        print(f"  {pid:12} active={row['active']} paused={safety.get('paused')} killSwitch={safety.get('killSwitch')} created={created}")

db.close()
