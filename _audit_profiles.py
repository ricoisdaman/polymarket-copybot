import sqlite3, json
from datetime import datetime, timezone

DB = "packages/db/prisma/dev.db"
c = sqlite3.connect(DB)
c.row_factory = sqlite3.Row

def ts(ms):
    try:
        return datetime.fromtimestamp(int(ms)/1000, tz=timezone.utc).strftime("%m-%d %H:%M UTC")
    except:
        return str(ms)

print("=== All profileIds in every table ===")
tables = ['ConfigVersion', 'LeaderCursor', 'LeaderEvent', 'CopyIntent', 'Fill',
          'Position', 'Alert', 'RuntimeMetric']
for t in tables:
    try:
        rows = c.execute(f'SELECT profileId, COUNT(*) as n FROM "{t}" GROUP BY profileId ORDER BY profileId').fetchall()
        print(f"  {t:20s}: {[(r['profileId'], r['n']) for r in rows]}")
    except Exception as e:
        print(f"  {t:20s}: ERROR {e}")

print()
print("=== ConfigVersion (all profiles, active only) ===")
for row in c.execute('SELECT profileId, id, createdAt, active, json FROM ConfigVersion ORDER BY profileId, active DESC').fetchall():
    cfg = json.loads(row['json'])
    leader = cfg.get('leaderWallet', cfg.get('leader', {}).get('wallet', 'N/A'))
    mode = cfg.get('mode', cfg.get('botMode', 'N/A'))
    print(f"  profileId={row['profileId']:12s}  active={row['active']}  mode={str(mode):8s}  leaderWallet={leader}")

print()
print("=== LeaderCursor (which wallets are being polled) ===")
for row in c.execute('SELECT profileId, leaderWallet, updatedAt FROM LeaderCursor').fetchall():
    print(f"  profileId={row['profileId']:12s}  wallet={row['leaderWallet']}  lastUpdated={ts(row['updatedAt'])}")

print()
print("=== Fills by profile ===")
for row in c.execute('''
    SELECT f.profileId, COUNT(*) as n, SUM(f.price*f.size) as usdc
    FROM Fill f GROUP BY f.profileId
''').fetchall():
    print(f"  profileId={row['profileId']:12s}  fills={row['n']}  totalUSDC=${row['usdc']:.4f}")

print()
print("=== Positions by profile ===")
for row in c.execute('SELECT profileId, COUNT(*) as n, SUM(size) as sz FROM Position GROUP BY profileId').fetchall():
    print(f"  profileId={row['profileId']:12s}  positions={row['n']}  totalSize={row['sz']:.4f}")

print()
print("=== RuntimeMetrics keys by profile ===")
for row in c.execute('SELECT profileId, COUNT(*) as n FROM RuntimeMetric GROUP BY profileId').fetchall():
    print(f"  profileId={row['profileId']:12s}  metricRows={row['n']}")

c.close()
