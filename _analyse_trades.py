"""
Full trade analysis script.
Run from workspace root: python _analyse_trades.py
Requires: pip install tabulate
"""
import sqlite3, json, sys
from datetime import datetime, timezone
from collections import defaultdict

DB = "packages/db/prisma/dev.db"

try:
    from tabulate import tabulate
    HAS_TAB = True
except ImportError:
    HAS_TAB = False
    def tabulate(rows, headers=(), tablefmt=""):
        lines = ["  ".join(str(h) for h in headers)]
        for r in rows:
            lines.append("  ".join(str(c) for c in r))
        return "\n".join(lines)

con = sqlite3.connect(DB)
con.row_factory = sqlite3.Row

# ─── 1. All fills (joined through Order → CopyIntent → LeaderEvent) ───────
fills = con.execute("""
    SELECT f.ts, f.price, f.size, f.price*f.size as usdc,
           o.side,
           ci.tokenId,
           json_extract(le.rawJson, '$.title') as title,
           json_extract(le.rawJson, '$.question') as question,
           le.price as leader_price
    FROM Fill f
    JOIN "Order" o ON o.id = f.orderId
    JOIN CopyIntent ci ON ci.id = o.intentId
    JOIN LeaderEvent le ON le.id = ci.leaderEventId
    WHERE f.profileId = 'live'
    ORDER BY f.ts ASC
""").fetchall()

# ─── 2. Current open positions ────────────────────────────────────────────
open_pos = con.execute("""
    SELECT p.tokenId, p.size, p.avgPrice, p.updatedAt
    FROM Position p
    WHERE p.profileId = 'live' AND p.size > 0
    ORDER BY p.updatedAt DESC
""").fetchall()

# ─── 3. Skipped intents grouped by reason ─────────────────────────────────
skips = con.execute("""
    SELECT ci.reason, COUNT(*) as cnt
    FROM CopyIntent ci
    WHERE ci.profileId = 'live' AND ci.status = 'SKIPPED'
    GROUP BY ci.reason
    ORDER BY cnt DESC
""").fetchall()

skip_details = con.execute("""
    SELECT ci.ts, ci.tokenId, ci.reason,
           le.price as leader_price, le.side,
           COALESCE(json_extract(le.rawJson,'$.title'), json_extract(le.rawJson,'$.question'), ci.tokenId) as title
    FROM CopyIntent ci
    LEFT JOIN LeaderEvent le ON le.id = ci.leaderEventId
    WHERE ci.profileId = 'live' AND ci.status = 'SKIPPED'
    ORDER BY ci.ts DESC
    LIMIT 50
""").fetchall()

# ─── 4. Runtime metrics snapshot ──────────────────────────────────────────
metrics = con.execute("""
    SELECT key, value FROM RuntimeMetric
    WHERE profileId = 'live'
    ORDER BY key
""").fetchall()

con.close()

# ─── SECTION 1: Overview ──────────────────────────────────────────────────
print("\n" + "="*72)
print("  FULL TRADE ANALYSIS")
print("="*72)

buy_fills  = [f for f in fills if f["side"] == "BUY"]
sell_fills = [f for f in fills if f["side"] == "SELL"]
total_spent = sum(f["usdc"] for f in buy_fills)
total_recv  = sum(f["usdc"] for f in sell_fills)

print(f"\n{'BUY fills':30s} {len(buy_fills)}")
print(f"{'SELL fills':30s} {len(sell_fills)}")
print(f"{'Total USDC spent (buys)':30s} ${total_spent:.4f}")
print(f"{'Total USDC received (sells)':30s} ${total_recv:.4f}")
print(f"{'Open positions':30s} {len(open_pos)}")

# ─── SECTION 2: Fill price distribution ───────────────────────────────────
print("\n" + "-"*72)
print("  BUY FILL PRICES")
print("-"*72)
fill_table = []
for f in buy_fills:
    mkt = (f["title"] or f["question"] or f["tokenId"] or "")[:42]
    fill_table.append([
        str(f["ts"])[:16],
        mkt,
        f"{f['price']:.4f}",
        f"(leader {f['leader_price']:.4f})",
        f"{f['size']:.4f}",
        f"${f['usdc']:.4f}",
    ])
print(tabulate(fill_table,
               headers=["Date (UTC)", "Market", "Fill Price", "Leader $", "Shares", "USDC"],
               tablefmt="simple"))

prices = [f["price"] for f in buy_fills]
if prices:
    print(f"\n  Min fill price:  {min(prices):.4f}")
    print(f"  Max fill price:  {max(prices):.4f}")
    print(f"  Avg fill price:  {sum(prices)/len(prices):.4f}")
    
    buckets = {
        "0.70–0.75": [p for p in prices if 0.70 <= p < 0.75],
        "0.75–0.80": [p for p in prices if 0.75 <= p < 0.80],
        "0.80–0.85": [p for p in prices if 0.80 <= p < 0.85],
        "0.85–0.90": [p for p in prices if 0.85 <= p < 0.90],
        "0.90–0.95": [p for p in prices if 0.90 <= p < 0.95],
        "0.95–1.00": [p for p in prices if 0.95 <= p <= 1.00],
    }
    print()
    for band, ps in buckets.items():
        bar = "█" * len(ps)
        print(f"  {band}: {len(ps):2d}  {bar}")

# ─── SECTION 3: Open positions ────────────────────────────────────────────
if open_pos:
    print("\n" + "-"*72)
    print("  OPEN POSITIONS")
    print("-"*72)
    op_table = []
    for p in open_pos:
        op_table.append([
            (p["tokenId"] or "")[:44],
            f"{p['size']:.4f}",
            f"{p['avgPrice']:.4f}",
            str(p["updatedAt"])[:16],
        ])
    print(tabulate(op_table,
                   headers=["Token ID", "Size", "Avg Buy", "Updated"],
                   tablefmt="simple"))

# ─── SECTION 4: Price band histogram (fills only — no P&L without Gamma) ─
print("\n" + "-"*72)
print("  FILL PRICE BAND BREAKDOWN (BUY fills)")
print("-"*72)

band_fills = defaultdict(list)
for f in buy_fills:
    p = f["price"]
    if   0.70 <= p < 0.75: band_fills["0.70–0.75"].append(f)
    elif 0.75 <= p < 0.80: band_fills["0.75–0.80"].append(f)
    elif 0.80 <= p < 0.85: band_fills["0.80–0.85"].append(f)
    elif 0.85 <= p < 0.90: band_fills["0.85–0.90"].append(f)
    elif 0.90 <= p < 0.95: band_fills["0.90–0.95"].append(f)
    elif 0.95 <= p <= 1.0:  band_fills["0.95–1.00"].append(f)
    else:                   band_fills["other"].append(f)

band_rows = []
for band in ["0.70–0.75","0.75–0.80","0.80–0.85","0.85–0.90","0.90–0.95","0.95–1.00","other"]:
    fs = band_fills.get(band, [])
    if not fs: continue
    usdc = sum(x["usdc"] for x in fs)
    band_rows.append([band, len(fs), f"${usdc:.4f}"])
print(tabulate(band_rows, headers=["Price Band", "# Fills", "USDC Spent"], tablefmt="simple"))

# ─── SECTION 5: Skip reasons ──────────────────────────────────────────────
print("\n" + "-"*72)
print("  SKIP REASONS (all time)")
print("-"*72)
total_skips = sum(s["cnt"] for s in skips)
print(tabulate([[s["reason"], s["cnt"], f"{100*s['cnt']/total_skips:.1f}%"] for s in skips],
               headers=["Reason", "Count", "%"], tablefmt="simple"))
print(f"\n  Total skips: {total_skips}")

# ─── SECTION 6: Recent skips detail ──────────────────────────────────────
print("\n" + "-"*72)
print("  RECENT 50 SKIPS (newest first)")
print("-"*72)
skip_rows = []
for s in skip_details:
    ts_str = str(s["ts"])[:16] if s["ts"] else "-"
    price = f"{s['leader_price']:.4f}" if s["leader_price"] else "-"
    skip_rows.append([ts_str, s["reason"], price, s["side"] or "-", (s["title"] or "")[:38]])
print(tabulate(skip_rows,
               headers=["Date", "Reason", "Leader $", "Side", "Market"],
               tablefmt="simple"))

# ─── SECTION 7: Daily cadence ────────────────────────────────────────────
print("\n" + "-"*72)
print("  BUYS PER DAY")
print("-"*72)
day_map = defaultdict(list)
for f in buy_fills:
    day = str(f["ts"])[:10]
    day_map[day].append(f)

for day in sorted(day_map.keys()):
    flist = day_map[day]
    avg_p = sum(f["price"] for f in flist) / len(flist)
    mkts = list({(f["title"] or f["question"] or "?")[:30] for f in flist})
    print(f"  {day}:  {len(flist)} trade(s)  avg price {avg_p:.4f}  {', '.join(mkts)}")

# ─── SECTION 8: Key metrics ───────────────────────────────────────────────
print("\n" + "-"*72)
print("  RUNTIME METRICS (current)")
print("-"*72)
key_metrics = {"bot.cash_usdc", "bot.starting_balance_usdc", "bot.drawdown_usdc",
               "bot.daily_notional_usdc", "bot.open_positions", "bot.heartbeat_ts"}
for m in metrics:
    if m["key"] in key_metrics:
        print(f"  {m['key']:42s}  {m['value']}")

print("\n" + "="*72)
print()
