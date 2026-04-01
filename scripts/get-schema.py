import sqlite3
import json
from pathlib import Path

db_path = Path(__file__).resolve().parents[1] / 'packages' / 'db' / 'prisma' / 'dev.db'
db = sqlite3.connect(str(db_path))
db.row_factory = sqlite3.Row

# Schema for key tables
for t in ['CopyIntent', 'Order', 'Fill', 'Position']:
    cols = [r[1] for r in db.execute('PRAGMA table_info("{}")'.format(t)).fetchall()]
    print('{}: {}'.format(t, cols))

print()
print('=== ORDERS sample ===')
orders = db.execute('SELECT * FROM "Order" ORDER BY rowid DESC LIMIT 3').fetchall()
if orders:
    print('Columns:', list(orders[0].keys()))
    for r in orders:
        print(' ', dict(r))

print()
print('=== FILLS sample ===')
fills2 = db.execute('SELECT * FROM Fill ORDER BY rowid DESC LIMIT 3').fetchall()
if fills2:
    print('Columns:', list(fills2[0].keys()))
    for r in fills2:
        print(' ', dict(r))

print()
print('=== POSITIONS ===')
positions = db.execute('SELECT * FROM Position ORDER BY rowid DESC LIMIT 10').fetchall()
if positions:
    print('Columns:', list(positions[0].keys()))
    for r in positions:
        print(' ', dict(r))

db.close()
