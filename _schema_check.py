import sqlite3
c = sqlite3.connect("packages/db/prisma/dev.db")
tables = c.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").fetchall()
print("Tables:")
for (t,) in tables:
    print(f"  {t}")
    cols = c.execute(f"PRAGMA table_info(\"{t}\")").fetchall()
    for col in cols:
        print(f"    {col[1]} ({col[2]})")
