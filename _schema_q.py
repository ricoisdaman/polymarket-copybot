import sqlite3
db = sqlite3.connect('packages/db/prisma/dev.db')
for t in ['ConfigVersion','RuntimeMetric','CopyIntent','LeaderEvent']:
    cols = [r[1] for r in db.execute(f'PRAGMA table_info({t})').fetchall()]
    print(f'{t}: {cols}')

# Last activity
print()
try:
    r = db.execute("SELECT MAX(ts) as last FROM CopyIntent").fetchone()
    print(f"Last CopyIntent: {r[0]}")
except: pass
try:
    r = db.execute("SELECT MAX(updatedAt) as last FROM RuntimeMetric").fetchone()
    print(f"Last RuntimeMetric: {r[0]}")
except: pass
try:
    r = db.execute("SELECT MAX(ts) as last FROM LeaderEvent").fetchone()
    print(f"Last LeaderEvent: {r[0]}")
except: pass
