import sqlite3, json
from datetime import datetime, timezone

c = sqlite3.connect('packages/db/prisma/dev.db')

print('=== leader2 new Fill/Order/CopyIntent since wipe ===')
fills = c.execute("SELECT COUNT(*) FROM Fill WHERE profileId='leader2'").fetchone()[0]
orders = c.execute("SELECT COUNT(*) FROM \"Order\" WHERE profileId='leader2'").fetchone()[0]
intents = c.execute("SELECT COUNT(*) FROM CopyIntent WHERE profileId='leader2'").fetchone()[0]
positions = c.execute("SELECT * FROM Position WHERE profileId='leader2' AND size > 0").fetchall()
print(f"  Fills: {fills}, Orders: {orders}, Intents: {intents}, OpenPositions: {len(positions)}")
for p in positions:
    print(f"    Pos: tokenId={p[1]}, size={p[3]}")

print()
print('=== leader4 ConfigVersion JSON (startingUSDC check) ===')
for row in c.execute("SELECT id, json FROM ConfigVersion WHERE profileId='leader4' AND active=1"):
    cfg = json.loads(row[1])
    print(f"  id={row[0]}")
    print(f"  budget={cfg.get('budget')}")

print()
print('=== All RuntimeMetrics for leader2 and leader4 ===')
for row in c.execute("SELECT profileId, key, value FROM RuntimeMetric WHERE profileId IN ('leader2','leader4') ORDER BY profileId, key"):
    print(f"  {row[0]} | {row[1]} = {row[2]}")
