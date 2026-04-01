import sqlite3, json

db = sqlite3.connect('packages/db/prisma/dev.db')
db.row_factory = sqlite3.Row

profiles_to_fix = ['leader2']

for pid in profiles_to_fix:
    row = db.execute(
        "SELECT id, active, json FROM ConfigVersion WHERE profileId=? ORDER BY createdAt DESC LIMIT 1",
        (pid,)
    ).fetchone()
    if not row:
        print(f"{pid}: no row found")
        continue
    cfg = json.loads(row['json'])
    safety = cfg.get('safety', {})
    print(f"{pid}: before: paused={safety.get('paused')}, killSwitch={safety.get('killSwitch')}")
    cfg['safety']['paused'] = False
    cfg['safety']['killSwitch'] = False
    db.execute(
        "UPDATE ConfigVersion SET json=? WHERE id=?",
        (json.dumps(cfg), row['id'])
    )
    print(f"{pid}: after: paused=False, killSwitch=False")

db.commit()
db.close()
print("Done.")
