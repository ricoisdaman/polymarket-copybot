"""
Full P&L diagnostic script - reads live DB safely via sqlite3.backup
Writes results to scripts/_pnl_result.txt
"""
import sqlite3, os, sys

DB = os.path.join(os.path.dirname(__file__), '..', 'packages', 'db', 'prisma', 'dev.db')
DB = os.path.abspath(DB)
OUT = os.path.join(os.path.dirname(__file__), '_pnl_result.txt')

print(f"DB: {DB}", flush=True)
print(f"Out: {OUT}", flush=True)

# Safe read of live DB via backup API
src = sqlite3.connect(f'file:{DB}?mode=ro&immutable=1', uri=True)
mem = sqlite3.connect(':memory:')
src.backup(mem)
src.close()
c = mem.cursor()

lines = []
def p(*args):
    line = ' '.join(str(a) for a in args)
    print(line, flush=True)
    lines.append(line)

# ── Schema inspection ────────────────────────────────────────────────
p("=== TABLE SCHEMAS ===")
for tbl in c.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").fetchall():
    tname = tbl[0]
    cols = c.execute(f"PRAGMA table_info([{tname}])").fetchall()
    col_names = [col[1] for col in cols]
    p(f"  {tname}: {col_names}")

# ── Order table ──────────────────────────────────────────────────────
p("\n=== ORDER TABLE SAMPLE ===")
order_cols = [col[1] for col in c.execute("PRAGMA table_info([Order])").fetchall()]
p("  Columns:", order_cols)
sample = c.execute("SELECT * FROM [Order] LIMIT 3").fetchall()
for row in sample:
    p(" ", dict(zip(order_cols, row)))

# ── Fill table ───────────────────────────────────────────────────────
p("\n=== FILL STATS ===")
fill_cols = [col[1] for col in c.execute("PRAGMA table_info(Fill)").fetchall()]
p("  Columns:", fill_cols)
p("  Total fills:", c.execute("SELECT COUNT(*) FROM Fill").fetchone()[0])
p("  By profileId:", c.execute("SELECT profileId, COUNT(*) FROM Fill GROUP BY profileId").fetchall())

# ── Derive BUY vs SELL from Order join ──────────────────────────────
p("\n=== BUY vs SELL (via Order join) ===")
# Check if Order has a 'side' or 'type' column
if 'side' in order_cols:
    side_col = 'side'
elif 'type' in order_cols:
    side_col = 'type'
else:
    side_col = None

if side_col:
    q = f"""
    SELECT o.{side_col}, o.profileId, COUNT(f.id) fills, SUM(f.price*f.size) notional, SUM(f.size) shares, SUM(f.fee) fees
    FROM Fill f JOIN [Order] o ON f.orderId = o.id
    GROUP BY o.{side_col}, o.profileId
    ORDER BY o.profileId, o.{side_col}
    """
    rows = c.execute(q).fetchall()
    for r in rows:
        p(f"  side={r[0]} profile={r[1]} fills={r[2]} notional=${r[3]:.2f} shares={r[4]:.4f} fees=${r[5]:.4f}")
else:
    p("  No side column in Order — listing all Order columns:", order_cols)

# ── Position table ───────────────────────────────────────────────────
p("\n=== POSITIONS ===")
pos_cols = [col[1] for col in c.execute("PRAGMA table_info(Position)").fetchall()]
p("  Columns:", pos_cols)
p("  Total positions:", c.execute("SELECT COUNT(*) FROM Position").fetchone()[0])
p("  Open (size>0):", c.execute("SELECT COUNT(*) FROM Position WHERE size>0").fetchone()[0])
p("  Closed (size<=0):", c.execute("SELECT COUNT(*) FROM Position WHERE size<=0").fetchone()[0])

# ── Per-token P&L via FIFO cost basis ────────────────────────────────
p("\n=== PER-TOKEN P&L (FIFO) ===")
p("  (Only profiles with fills shown)")

# Get all fills joined to orders (tokenId lives in CopyIntent, not Order)
intent_cols = [col[1] for col in c.execute("PRAGMA table_info(CopyIntent)").fetchall()]
p("  CopyIntent columns:", intent_cols)
if side_col and 'tokenId' in intent_cols:
    all_fills = c.execute(f"""
    SELECT f.ts, o.{side_col} side, ci.tokenId, f.price, f.size, f.fee, o.profileId
    FROM Fill f
    JOIN [Order] o ON f.orderId = o.id
    JOIN CopyIntent ci ON o.intentId = ci.id
    ORDER BY ci.tokenId, f.ts
    """).fetchall()
else:
    all_fills = []
    p("  Cannot join tokenId: side_col={}, intent_cols={}".format(side_col, intent_cols))

if all_fills:
    from collections import defaultdict
    
    # FIFO P&L per tokenId
    token_data = defaultdict(list)
    for row in all_fills:
        ts, side, tokenId, price, size, fee, profileId = row
        token_data[tokenId].append({'ts': ts, 'side': side, 'price': price, 'size': size, 'fee': fee, 'profile': profileId})
    
    total_realized = 0.0
    total_fees = 0.0
    total_invested = 0.0
    open_tokens = 0
    closed_tokens = 0
    
    token_summary = []
    for tokenId, fills in token_data.items():
        buy_queue = []  # FIFO queue of (price, size)
        realized = 0.0
        fees = 0.0
        open_cost = 0.0
        open_shares = 0.0
        
        for f in sorted(fills, key=lambda x: x['ts']):
            fees += f['fee']
            if f['side'] in ('BUY', 'buy'):
                buy_queue.append([f['price'], f['size']])
                open_cost += f['price'] * f['size']
                open_shares += f['size']
            elif f['side'] in ('SELL', 'sell'):
                sell_size = f['size']
                while sell_size > 1e-9 and buy_queue:
                    head_price, head_size = buy_queue[0]
                    consumed = min(head_size, sell_size)
                    realized += (f['price'] - head_price) * consumed
                    open_cost -= head_price * consumed
                    open_shares -= consumed
                    sell_size -= consumed
                    buy_queue[0][1] -= consumed
                    if buy_queue[0][1] < 1e-9:
                        buy_queue.pop(0)
        
        # Look up current DB size
        db_pos = c.execute("SELECT size FROM Position WHERE tokenId=?", (tokenId,)).fetchone()
        db_size = db_pos[0] if db_pos else 0.0
        
        # Get last price from fills
        last_fill_price = fills[-1]['price'] if fills else 0.0
        
        unrealized = open_shares * (last_fill_price - (open_cost / open_shares if open_shares > 0.001 else 0))
        total_pnl = realized + unrealized
        
        total_realized += realized
        total_fees += fees
        total_invested += sum(f['price']*f['size'] for f in fills if f['side'] in ('BUY', 'buy'))
        
        if open_shares > 0.001:
            open_tokens += 1
        else:
            closed_tokens += 1
        
        token_summary.append((total_pnl, tokenId[:16], open_shares, realized, unrealized, fees, last_fill_price, db_size))
    
    # Sort by P&L descending
    token_summary.sort(reverse=True)
    
    p(f"\n  {'Token':18} {'OpenShares':>12} {'Realized':>10} {'Unrealized':>12} {'TotalPnL':>10} {'Fees':>8} {'LastPx':>8} {'DBSize':>8}")
    p(f"  {'-'*90}")
    for pnl, tok, os_, real, unreal, fees, lpx, dbs in token_summary:
        status = 'OPEN' if os_ > 0.001 else 'CLOSED'
        p(f"  {tok:18} {os_:>12.4f} {real:>10.4f} {unreal:>12.4f} {pnl:>10.4f} {fees:>8.4f} {lpx:>8.4f} {dbs:>8.4f} [{status}]")
    
    p(f"\n  SUMMARY:")
    p(f"  Total invested (BUY notional): ${total_invested:.2f}")
    p(f"  Total realized P&L:            ${total_realized:.4f}")
    p(f"  Total fees paid:               ${total_fees:.4f}")
    p(f"  Open tokens:    {open_tokens}")
    p(f"  Closed tokens:  {closed_tokens}")

# ── Runtime state / balance ──────────────────────────────────────────
p("\n=== RUNTIME STATE ===")
state_cols = [col[1] for col in c.execute("PRAGMA table_info(RuntimeState)").fetchall()]
p("  Columns:", state_cols)
states = c.execute("SELECT * FROM RuntimeState").fetchall()
for s in states:
    p(" ", dict(zip(state_cols, s)))

# ── Profile balances ─────────────────────────────────────────────────
p("\n=== PROFILES ===")
try:
    prof_cols = [col[1] for col in c.execute("PRAGMA table_info(Profile)").fetchall()]
    p("  Columns:", prof_cols)
    profiles = c.execute("SELECT * FROM Profile").fetchall()
    for pr in profiles:
        p(" ", dict(zip(prof_cols, pr)))
except Exception as e:
    p("  Error:", e)

# ── Write to file ────────────────────────────────────────────────────
with open(OUT, 'w', encoding='utf-8') as fh:
    fh.write('\n'.join(lines))

print(f"\nWrote {len(lines)} lines to {OUT}", flush=True)
sys.stderr.write("Done.\n")
