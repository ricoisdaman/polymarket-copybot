import sqlite3
import json
from pathlib import Path

db_path = Path(__file__).resolve().parents[1] / 'packages' / 'db' / 'prisma' / 'dev.db'
db = sqlite3.connect(str(db_path))
db.row_factory = sqlite3.Row

buy_q = 'SELECT COALESCE(SUM(f.price * f.size), 0) as t, COUNT(*) as n FROM Fill f JOIN "Order" o ON f.orderId=o.id JOIN CopyIntent ci ON o.intentId=ci.id WHERE ci.side="BUY"'
sell_q = 'SELECT COALESCE(SUM(f.price * f.size), 0) as t, COUNT(*) as n FROM Fill f JOIN "Order" o ON f.orderId=o.id JOIN CopyIntent ci ON o.intentId=ci.id WHERE ci.side="SELL"'
pos_q = 'SELECT COALESCE(SUM(size * avgPrice), 0) as t FROM Position WHERE size > 0.001'

buy_row = db.execute(buy_q).fetchone()
sell_row = db.execute(sell_q).fetchone()
pos_val = db.execute(pos_q).fetchone()['t']

buy = float(buy_row['t'])
sell = float(sell_row['t'])
buys = buy_row['n']
sells = sell_row['n']

print('=== P&L SUMMARY ===')
print('  BUY  trades: {}   USDC spent:    ${:.2f}'.format(buys, buy))
print('  SELL trades: {}   USDC received: ${:.2f}'.format(sells, sell))
print('  Cash freed up (net sells-buys): ${:.2f}'.format(sell - buy))
print('  Open position book value:       ${:.2f}'.format(pos_val))
print('  Starting capital:               $50.00')
print('  Cash remaining estimate:        ${:.2f}'.format(50 + sell - buy))
print('  Total portfolio (cash+positions): ${:.2f}'.format(50 + sell - buy + pos_val))
print()

print('=== OPEN POSITIONS ===')
for r in db.execute('SELECT tokenId, size, avgPrice, (size*avgPrice) as value FROM Position WHERE size > 0.001 ORDER BY value DESC').fetchall():
    print('  size:{:.4f}  avgPrice:{:.4f}  value:${:.2f}  token:{}...'.format(
        float(r['size']), float(r['avgPrice']), float(r['value']), str(r['tokenId'])[:20]))

print()
print('=== KILL SWITCH CAUSE ===')
errs = db.execute("SELECT ts, contextJson FROM Alert WHERE code='LIVE_EXECUTION_ERROR' ORDER BY ts DESC LIMIT 3").fetchall()
for r in errs:
    meta = json.loads(r['contextJson'])
    print(' ', meta.get('error','')[:140])

db.close()
