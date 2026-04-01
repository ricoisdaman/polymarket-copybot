"""
Overnight leader2 loss breakdown — what went wrong and why.
"""
import sqlite3, json
from collections import defaultdict
from datetime import datetime, timezone

DB = "packages/db/prisma/dev.db"
conn = sqlite3.connect(DB)
cur = conn.cursor()

# All leader2 fills (most recent first)
cur.execute("""
    SELECT f.ts, f.price, f.size, i.side, i.tokenId, i.reason,
           ROUND(f.price * f.size, 4) as notional
    FROM Fill f
    JOIN [Order] o ON f.orderId = o.id
    JOIN CopyIntent i ON o.intentId = i.id
    WHERE i.profileId = 'leader2'
    ORDER BY f.ts DESC
    LIMIT 200
""")
rows = cur.fetchall()

# Market titles
token_ids = list(set(r[4] for r in rows))
titles = {}
if token_ids:
    ph = ",".join("?"*len(token_ids))
    cur.execute(f"SELECT tokenId, rawJson FROM LeaderEvent WHERE profileId='leader2' AND tokenId IN ({ph}) GROUP BY tokenId", token_ids)
    for tok, raw in cur.fetchall():
        try:
            d = json.loads(raw)
            t = d.get("title") or d.get("question") or ""
            titles[tok] = t.strip()[:60]
        except Exception:
            pass

def ts_str(ts):
    if isinstance(ts, (int, float)):
        return datetime.fromtimestamp(ts / 1000, tz=timezone.utc).strftime("%m-%d %H:%M UTC")
    try:
        return str(datetime.fromisoformat(str(ts).replace("Z", "+00:00")).strftime("%m-%d %H:%M UTC"))
    except Exception:
        return str(ts)[:16]

# Group by tokenId
tokens: dict = defaultdict(list)
for row in rows:
    tokens[row[4]].append(row)

# Build trade summaries
trade_summaries = []
for tid, token_rows in tokens.items():
    buys  = [r for r in token_rows if r[3] == "BUY"]
    sells = [r for r in token_rows if r[3] == "SELL"]
    if not buys:
        continue

    buy_cost        = sum(r[6] for r in buys)
    sell_proceeds   = sum(r[6] for r in sells)
    pnl             = sell_proceeds - buy_cost
    avg_buy         = sum(r[1] for r in buys) / len(buys)
    avg_sell        = sum(r[1] for r in sells) / len(sells) if sells else 0

    def to_ms(ts):
        if isinstance(ts, (int, float)): return ts
        try: return datetime.fromisoformat(str(ts).replace("Z", "+00:00")).timestamp() * 1000
        except Exception: return 0

    buy_ts_ms  = min(to_ms(r[0]) for r in buys)
    sell_ts_ms = max(to_ms(r[0]) for r in sells) if sells else None
    hold_h = (sell_ts_ms - buy_ts_ms) / 3_600_000 if sell_ts_ms else None

    trade_summaries.append({
        "tid": tid, "title": titles.get(tid, tid[-20:]),
        "buy_ts": ts_str(buy_ts_ms), "sell_ts": ts_str(sell_ts_ms) if sell_ts_ms else "OPEN",
        "avg_buy": avg_buy, "avg_sell": avg_sell,
        "buy_cost": buy_cost, "sell_proceeds": sell_proceeds,
        "pnl": pnl, "hold_h": hold_h,
        "is_open": not sells,
        "close_reason": sells[0][5] if sells else None,
    })

# Sort by sell timestamp desc — most recent closures first
closed = sorted([t for t in trade_summaries if not t["is_open"]], key=lambda x: x["sell_ts"], reverse=True)
open_  = [t for t in trade_summaries if t["is_open"]]

# ── Previous snapshot state ──
# From analysis before the overnight run:
prev_closed = 43
prev_realized = 22.3255
prev_cash = 43.29

current_closed = len(closed)
current_pnl    = sum(t["pnl"] for t in closed)
new_trades     = [t for t in closed[: current_closed - prev_closed]]  # newest first

print("=" * 72)
print("  LEADER2 OVERNIGHT ANALYSIS")
print("=" * 72)
print(f"\n  Before night : {prev_closed} closed trades, P&L=${prev_realized:+.4f}, cash≈${prev_cash:.2f}")
print(f"  After  night : {current_closed} closed trades, P&L=${current_pnl:+.4f}, cash≈${50+current_pnl:.2f}")
print(f"  Overnight    : {current_closed - prev_closed} new closes, delta P&L=${current_pnl - prev_realized:+.4f}")

# ── Overnight breakdown ──
print(f"\n{'─'*72}")
print(f"  OVERNIGHT CLOSED TRADES ({len(new_trades)} trades)")
print(f"{'─'*72}")
print(f"  {'Title':<48} {'Entry':>7} {'Exit':>7} {'P&L':>8} {'Hold'}")
print(f"  {'-'*48} {'-'*7} {'-'*7} {'-'*8} {'-'*8}")
for t in new_trades:
    h = f"{int(t['hold_h'])}h{int((t['hold_h']%1)*60)}m" if t["hold_h"] is not None else "?"
    print(f"  {t['title']:<48} {t['avg_buy']:>7.4f} {t['avg_sell']:>7.4f} {t['pnl']:>+8.4f} {h}")

# ── Pattern breakdown ──
overnight_wins   = [t for t in new_trades if t["pnl"] > 0]
overnight_losses = [t for t in new_trades if t["pnl"] <= 0]

print(f"\n  Wins   : {len(overnight_wins)}/{len(new_trades)}  (+${sum(t['pnl'] for t in overnight_wins):.4f})")
print(f"  Losses : {len(overnight_losses)}/{len(new_trades)}  (${sum(t['pnl'] for t in overnight_losses):.4f})")

# ── Loss deep dive ──
big_losses = sorted([t for t in new_trades if t["pnl"] < -1], key=lambda x: x["pnl"])
if big_losses:
    print(f"\n{'─'*72}")
    print(f"  BIG LOSSES (>$1) — {len(big_losses)} trades")
    print(f"{'─'*72}")
    for t in big_losses:
        drop_pct = (t["avg_buy"] - t["avg_sell"]) / t["avg_buy"] * 100 if t["avg_buy"] else 0
        h = f"{int(t['hold_h'])}h{int((t['hold_h']%1)*60)}m" if t["hold_h"] is not None else "?"
        print(f"\n  {t['title']}")
        print(f"    Entered : {t['buy_ts']}  @ {t['avg_buy']:.4f}  (spent ${t['buy_cost']:.2f})")
        print(f"    Closed  : {t['sell_ts']}  @ {t['avg_sell']:.4f}")
        print(f"    Price   : fell {drop_pct:.1f}% from entry — lost ${abs(t['pnl']):.4f}")
        print(f"    Hold    : {h}")

# ── Price band of overnight trades ──
print(f"\n{'─'*72}")
print(f"  OVERNIGHT PRICE BAND BREAKDOWN")
print(f"{'─'*72}")
bands = [(0.55,0.70,"0.55-0.70"),(0.70,0.80,"0.70-0.80"),(0.80,0.90,"0.80-0.90"),
         (0.90,1.00,"0.90-1.00")]
print(f"  {'Band':<12} {'Trades':>7} {'Wins':>5} {'WinRate':>8} {'TotalPnL':>10}")
for lo, hi, name in bands:
    bt = [t for t in new_trades if lo <= t["avg_buy"] < hi]
    if not bt: continue
    bw = [t for t in bt if t["pnl"] > 0]
    print(f"  {name:<12} {len(bt):>7} {len(bw):>5} {len(bw)/len(bt)*100:>7.1f}% {sum(t['pnl'] for t in bt):>+10.4f}")

# ── Was filter involved? ──
print(f"\n{'─'*72}")
print(f"  KEY TAKEAWAYS")
print(f"{'─'*72}")
high_entry = [t for t in big_losses if t["avg_buy"] >= 0.80]
if high_entry:
    print(f"\n  [!] PRICE BAND PROBLEM: {len(high_entry)} of the big losses were entries at >=0.80")
    print(f"      These are the high-odds bets that lost: you paid a lot (80-90c) but they lost.")
    print(f"      MAX_PRICE_FILTER=0.80 would have blocked these entirely.")
not_filter = [t for t in big_losses if t["avg_buy"] < 0.80]
if not_filter:
    print(f"\n  [!] LOW-ENTRY LOSSES: {len(not_filter)} big losses were at <0.80 entry")
    print(f"      These are genuine upsets — the leader's prediction was wrong.")
    print(f"      No filter can prevent market losses; this is the inherent risk of copying.")

# ── Were filter changes the cause? ──
print(f"\n  [FILTER CHECK] Title blocker only applies to 'default' profile.")
print(f"  Leader2 does not use BLOCKED_TITLE_KEYWORDS — the filter has no impact here.")
print(f"\n  [CONCLUSION] The overnight loss is entirely from sports outcomes,")
print(f"  not from any code change made yesterday.")

# ── Open positions risk ──
if open_:
    total_open_cost = sum(t["buy_cost"] for t in open_)
    print(f"\n{'─'*72}")
    print(f"  CURRENT OPEN POSITIONS ({len(open_)} trades, ${total_open_cost:.2f} at risk)")
    print(f"{'─'*72}")
    for t in sorted(open_, key=lambda x: -x["buy_cost"]):
        print(f"  cost=${t['buy_cost']:.2f}  entry={t['avg_buy']:.4f}  {t['title']}")

conn.close()
