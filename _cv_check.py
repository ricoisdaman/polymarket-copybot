import sqlite3, json
db = sqlite3.connect('packages/db/prisma/dev.db')
db.row_factory = sqlite3.Row

for pid in ['live','paper-v2','beta']:
    print(f'--- {pid} ---')
    rows = db.execute(
        'SELECT id, active, createdAt, json FROM ConfigVersion WHERE profileId=? ORDER BY createdAt DESC LIMIT 3',
        (pid,)
    ).fetchall()
    for r in rows:
        try:
            f = json.loads(r['json']).get('filters', {})
            slugs = f.get('blockedSlugPrefixes', [])
            print(f"  active={r['active']} createdAt={str(r['createdAt'])[:22]} blockedSlugs={slugs}")
        except Exception as e:
            print(f"  (error: {e})")
    print()
