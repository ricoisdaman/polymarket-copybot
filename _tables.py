import sqlite3
c = sqlite3.connect("packages/db/prisma/dev.db")
tables = [r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type='table'")]
print(tables)
for t in tables:
    cols = [r[1] for r in c.execute(f"PRAGMA table_info({t})")]
    print(f"  {t}: {cols}")
c.close()
