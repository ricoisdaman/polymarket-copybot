"""Diagnose P&L, closed position values, leader vs bot comparison."""
import sqlite3, json, collections, sys
from pathlib import Path
from datetime import datetime, timezone

DB   = 'packages/db/prisma/dev.db'
OUT  = str(Path(__file__).resolve().parent / '_diag_result.txt')
PROF = 'default'

# Safe read of live DB: backup to in-memory copy
try:
    src = sqlite3.connect(f'file:{DB}?mode=ro&immutable=1', uri=True)
    mem = sqlite3.connect(':memory:')
    src.backup(mem)
    src.close()
    conn = mem
except Exception as e:
    sys.stderr.write(f"Backup failed ({e}), using direct open\n")
    conn = sqlite3.connect(DB)

conn.row_factory = sqlite3.Row
c   = conn.cursor()
out = open(OUT, 'w', encoding='utf-8')
p   = lambda *a, **kw: print(*a, **kw, file=out)

# ── Fills ────────────────────────────────────────────────────────────────────
c.execute("""
    SELECT ci.side, f.price, f.size, f.price*f.size as notional,
           ci.tokenId, f.ts, ci.mode
    FROM Fill f
    JOIN "Order" o  ON f.orderId  = o.id
    JOIN CopyIntent ci ON o.intentId = ci.id
    WHERE f.profileId = ? ORDER BY f.ts ASC
""", (PROF,))
fills     = c.fetchall()
buys      = [r for r in fills if r['side']=='BUY']
sells     = [r for r in fills if r['side']=='SELL']
lbuys     = [r for r in fills if r['side']=='BUY'  and r['mode']=='LIVE']
lsells    = [r for r in fills if r['side']=='SELL' and r['mode']=='LIVE']
lbuy_not  = sum(r['notional'] for r in lbuys)
lsell_not = sum(r['notional'] for r in lsells)

p("="*60); p("FILL SUMMARY"); p("="*60)
p(f"ALL  BUY  fills: {len(buys):3d}  ${sum(r['notional'] for r in buys):.2f}")
p(f"ALL  SELL fills: {len(sells):3d}  ${sum(r['notional'] for r in sells):.2f}")
p(f"LIVE BUY  fills: {len(lbuys):3d}  ${lbuy_not:.2f}")
p(f"LIVE SELL fills: {len(lsells):3d}  ${lsell_not:.2f}")

# ── Per-token P&L (LIVE) ─────────────────────────────────────────────────────
agg = {}
for r in fills:
    if r['mode'] != 'LIVE': continue
    tid = r['tokenId']
    if tid not in agg:
        agg[tid] = dict(os=0, oc=0, rpnl=0, tbuy=0, tsell=0, lp=r['price'])
    a = agg[tid]
    if r['side'] == 'BUY':
        a['os'] += r['size']; a['oc'] += r['notional']; a['tbuy'] += r['notional']
    else:
        avg  = a['oc']/a['os'] if a['os'] > 0 else r['price']
        cs   = min(a['os'], r['size'])
        a['rpnl'] += (r['price'] - avg) * cs
        a['os']    = max(0, a['os'] - r['size'])
        a['oc']    = max(0, a['oc'] - avg * cs)
        a['tsell'] += r['notional']
    a['lp'] = r['price']

c.execute("SELECT tokenId, size FROM Position WHERE profileId=?", (PROF,))
dbpos = {r['tokenId']: r['size'] for r in c.fetchall()}

tot_real=0; tot_unreal=0; tot_pos_val=0
p(); p("="*60); p("PER-TOKEN P&L (LIVE)"); p("="*60)
p(f"{'Token':<28} {'Shares':>9} {'AvgBuy':>7} {'LastPx':>7} {'Cost':>7} {'Realized':>9} Status")
p("-"*85)
for tid, a in sorted(agg.items(), key=lambda x: x[1]['rpnl']):
    is_open = dbpos.get(tid, 0) > 0.001 and a['os'] > 0.001
    avg_buy = a['oc']/a['os'] if a['os'] > 0.001 else 0
    unreal  = a['os']*a['lp'] - a['oc']
    tot_real += a['rpnl']
    if is_open:
        tot_unreal   += unreal
        tot_pos_val  += a['os']*a['lp']
    status = 'OPEN' if is_open else 'CLOSED'
    p(f"{tid[:26]:<28} {a['os']:>9.4f} {avg_buy:>7.4f} {a['lp']:>7.4f} "
      f"${a['oc']:>6.2f} ${a['rpnl']:>8.4f} {status}")
p("-"*85)
p(f"{'TOTAL REALIZED':<50} ${tot_real:>8.4f}")
p()
p(f"Realized P&L:    ${tot_real:.4f}")
p(f"Unrealized P&L:  ${tot_unreal:.4f}")
p(f"Total P&L:       ${tot_real + tot_unreal:.4f}")
p(f"Open value:      ${tot_pos_val:.4f}")

# ── DB Position table ─────────────────────────────────────────────────────────
c.execute("SELECT tokenId, size, avgPrice FROM Position WHERE profileId=? AND size>0 ORDER BY updatedAt DESC", (PROF,))
dbo = c.fetchall()
p(); p("="*60); p(f"DB POSITIONS OPEN: {len(dbo)}"); p("="*60)
for r in dbo[:20]:
    p(f"  {r['tokenId'][:30]} size={r['size']:.4f} avg={r['avgPrice']:.4f}")

# ── Closed positions analysis ─────────────────────────────────────────────────
closed = [(t,a) for t,a in agg.items() if dbpos.get(t,0) <= 0.001 or a['os'] <= 0.001]
p(); p("="*60); p(f"CLOSED POSITIONS: {len(closed)}"); p("="*60)
cbuy = sum(a['tbuy'] for _,a in closed)
csell= sum(a['tsell'] for _,a in closed)
crpnl= sum(a['rpnl'] for _,a in closed)
p(f"Closed total bought:     ${cbuy:.4f}")
p(f"Closed total sold:       ${csell:.4f}")
p(f"Closed realized P&L:     ${crpnl:.4f}")
p()
p("Closed positions detail:")
for tid, a in sorted(closed, key=lambda x: x[1]['rpnl']):
    p(f"  {tid[:26]} bought=${a['tbuy']:.2f} sold=${a['tsell']:.2f} pnl=${a['rpnl']:.4f}")

# ── Leader vs bot ─────────────────────────────────────────────────────────────
p(); p("="*60); p("LEADER vs BOT (last 200 leader events)"); p("="*60)
c.execute("""
    SELECT le.side, le.price, le.ts, ci.status, ci.reason, ci.mode
    FROM LeaderEvent le
    LEFT JOIN CopyIntent ci ON ci.leaderEventId=le.id AND ci.profileId=?
    WHERE le.profileId=?
    ORDER BY le.ts DESC LIMIT 200
""", (PROF, PROF))
le_rows = c.fetchall()
stat_ctr = collections.Counter(r['status'] or 'NONE' for r in le_rows)
p(f"Statuses: {dict(stat_ctr)}")
skip_ctr = collections.Counter(r['reason'] for r in le_rows if r['status']=='SKIPPED' and r['reason'])
p("Skip reasons:")
for k,v in skip_ctr.most_common(): p(f"  {k}: {v}")

c.execute("SELECT side, COUNT(*) cnt, AVG(price) ap FROM LeaderEvent WHERE profileId=? GROUP BY side", (PROF,))
for r in c.fetchall(): p(f"Leader {r['side']}: {r['cnt']} @ avg ${r['ap']:.4f}")

# Price lag analysis
c.execute("""
    SELECT le.price lp, f.price fp, f.price-le.price slip,
           f.ts fill_ts, le.ts le_ts
    FROM Fill f
    JOIN "Order" o  ON f.orderId=o.id
    JOIN CopyIntent ci ON o.intentId=ci.id
    JOIN LeaderEvent le ON ci.leaderEventId=le.id
    WHERE ci.profileId=? AND ci.mode='LIVE' AND ci.side='BUY'
    ORDER BY f.ts DESC LIMIT 100
""", (PROF,))
pc = c.fetchall()
if pc:
    avg_s = sum(r['slip'] for r in pc)/len(pc)
    p(f"\nBUY slippage vs leader ({len(pc)} samples): avg {avg_s:+.4f} ({avg_s*100:+.2f}c)")
    worst = max(pc, key=lambda r: r['slip'])
    p(f"  Worst buy: leader={worst['lp']:.4f}  ours={worst['fp']:.4f}  slip={worst['slip']:+.4f}")
    # Also show time lag
    time_lags = []
    for r in pc:
        try:
            le_ts = datetime.fromisoformat(str(r['le_ts'])).timestamp()
            fi_ts = datetime.fromisoformat(str(r['fill_ts'])).timestamp()
            time_lags.append(fi_ts - le_ts)
        except: pass
    if time_lags:
        avg_lag = sum(time_lags)/len(time_lags)
        p(f"  Avg time from leader trade to our fill: {avg_lag:.1f}s")

# Sell side same analysis
c.execute("""
    SELECT le.price lp, f.price fp, le.price-f.price slip
    FROM Fill f
    JOIN "Order" o  ON f.orderId=o.id
    JOIN CopyIntent ci ON o.intentId=ci.id
    JOIN LeaderEvent le ON ci.leaderEventId=le.id
    WHERE ci.profileId=? AND ci.mode='LIVE' AND ci.side='SELL'
    ORDER BY f.ts DESC LIMIT 100
""", (PROF,))
sc = c.fetchall()
if sc:
    avg_ss = sum(r['slip'] for r in sc)/len(sc)
    p(f"\nSELL slippage vs leader ({len(sc)} samples): avg {avg_ss:+.4f} ({avg_ss*100:+.2f}c)")

# Fees
c.execute("SELECT SUM(fee) tf, COUNT(*) fc FROM Fill WHERE profileId=?", (PROF,))
fr = c.fetchone()
p(f"\nTotal fees: ${fr['tf'] or 0:.4f} over {fr['fc']} fills")

p(); p("="*60); p("PORTFOLIO SUMMARY"); p("="*60)
p(f"Realized P&L:    ${tot_real:.4f}")
p(f"Unrealized P&L:  ${tot_unreal:.4f}")
p(f"Total P&L:       ${tot_real+tot_unreal:.4f}")
p(f"USDC spent:      ${lbuy_not:.4f}")
p(f"USDC received:   ${lsell_not:.4f}")
p(f"Net cash change: ${lsell_not-lbuy_not:.4f}")

conn.close()
out.close()
sys.stderr.write("Done.\n")
