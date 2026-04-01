import sqlite3
import json
import time
from pathlib import Path

db_path = Path(__file__).resolve().parents[1] / 'packages' / 'db' / 'prisma' / 'dev.db'
db = sqlite3.connect(str(db_path))
db.row_factory = sqlite3.Row

row = db.execute('SELECT id, json FROM ConfigVersion WHERE active=1 ORDER BY createdAt DESC LIMIT 1').fetchone()
if not row:
    print('No active config found')
    db.close()
    exit(1)

cfg = json.loads(row['json'])
print('Before:', cfg.get('safety'))

cfg.setdefault('safety', {})
cfg['safety']['killSwitch'] = False
cfg['safety']['paused'] = False

ts = int(time.time() * 1000)
new_id = 'reset-{}'.format(ts)

db.execute('UPDATE ConfigVersion SET active=0 WHERE active=1')
db.execute(
    'INSERT INTO ConfigVersion (id, json, active, createdAt) VALUES (?,?,1,?)',
    [new_id, json.dumps(cfg), ts]
)
db.commit()

row2 = db.execute('SELECT json FROM ConfigVersion WHERE active=1 ORDER BY createdAt DESC LIMIT 1').fetchone()
cfg2 = json.loads(row2['json'])
print('After: ', cfg2.get('safety'))
print('Kill switch cleared.')
db.close()
