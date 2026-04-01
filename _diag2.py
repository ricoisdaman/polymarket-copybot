import sqlite3
from datetime import datetime, timezone

DB = 'packages/db/prisma/dev.db'
c = sqlite3.connect(DB)
c.row_factory = sqlite3.Row

print('=== ALERTS (all, newest first) ===')
alerts = c.execute('SELECT * FROM Alert ORDER BY ts DESC LIMIT 50').fetchall()
if not alerts:
    print('  (no alerts)')
for a in alerts:
    ts = datetime.fromtimestamp(a[chr(116)+chr(115)]/1000, tz=timezone.utc)
    print(ts.strftime('%m-%d %H:%M UTC'), dict(a))

print()
print('=== RUNTIME METRICS ===')
for row in c.execute('SELECT key, value, updatedAt FROM RuntimeMetric ORDER BY key').fetchall():
    ts = datetime.fromtimestamp(int(row['updatedAt'])/1000, tz=timezone.utc)
    print(f'  {row[chr(107)+chr(101)+chr(121)]:50}  {str(row[chr(118)+chr(97)+chr(108)+chr(117)+chr(101)]):<25}  @{ts.strftime(chr(37)+chr(109)+chr(45)+chr(37)+chr(100)+chr(32)+chr(37)+chr(72)+chr(58)+chr(37)+chr(77)+chr(32)+chr(85)+chr(84)+chr(67))}')

print()
print('=== PAUSED skips (newest 30) ===')
paused = c.execute('''SELECT ci.ts, ci.reason, json_extract(le.rawJson, chr(36)||chr(46)||chr(116)||chr(105)||chr(116)||chr(108)||chr(101)) as title, le.side, le.price FROM CopyIntent ci JOIN LeaderEvent le ON le.id = ci.leaderEventId WHERE ci.reason=chr(80)||chr(65)||chr(85)||chr(83)||chr(69)||chr(68) ORDER BY ci.ts DESC LIMIT 30''').fetchall()
print(f'  count={len(paused)}')
for p in paused:
    ts = datetime.fromtimestamp(p['ts']/1000, tz=timezone.utc)
    print(f'  {ts.strftime("%m-%d %H:%M UTC")}  {p["side"]:3}  price={p["price"]}  {str(p["title"] or "")[:60]}')

print()
print('=== RECENT FILLS ===')
fills = c.execute('''SELECT f.ts, f.price, f.price*f.size as usdc, o.side, json_extract(le.rawJson, chr(36)||chr(46)||chr(116)||chr(105)||chr(116)||chr(108)||chr(101)) as title FROM Fill f JOIN "Order" o ON o.id=f.orderId JOIN CopyIntent ci ON ci.id=o.intentId JOIN LeaderEvent le ON le.id=ci.leaderEventId ORDER BY f.ts DESC LIMIT 15''').fetchall()
for f in fills:
    ts = datetime.fromtimestamp(f['ts']/1000, tz=timezone.utc)
    print(f'  {ts.strftime("%m-%d %H:%M UTC")}  {f["side"]:4}  dollar{f["price"]:.4f}  dollar{f["usdc"]:.4f}  {str(f["title"] or "")[:55]}')

c.close()
