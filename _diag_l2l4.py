import sqlite3, json
c = sqlite3.connect('packages/db/prisma/dev.db')

print('=== ConfigVersion ===')
for row in c.execute("SELECT profileId, id, active, json FROM ConfigVersion WHERE profileId IN ('leader2','leader4') ORDER BY profileId, createdAt DESC"):
    cfg = json.loads(row[3])
    budget = cfg.get('budget', {})
    print(f"  {row[0]} | active={row[2]} | mode={cfg.get('mode')} | startingUSDC={budget.get('startingUSDC')} | id={row[1]}")

print()
print('=== RuntimeMetric ===')
for row in c.execute("SELECT profileId, key, value FROM RuntimeMetric WHERE profileId IN ('leader2','leader4') ORDER BY profileId, key"):
    print(f"  {row[0]} | {row[1]} = {row[2]}")
