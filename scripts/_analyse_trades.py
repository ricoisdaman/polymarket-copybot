"""
Comprehensive multi-profile trade analysis.
Analyses: P&L, price bands, market titles, hold time, win rate,
          exit source (SELL fill vs sync close), and skip/reject patterns.
"""
import sqlite3, json, re
from collections import defaultdict
from datetime import datetime, timezone

DB = "packages/db/prisma/dev.db"
STARTING_USDC = 50.0
PROFILES = {
    "default":  "bloodmaster",
    "leader2":  "sports-trader",
    "leader3":  "0x965D0",
    "leader4":  "0xa82af",
}

conn = sqlite3.connect(DB)
cur = conn.cursor()

# ─── helpers ─────────────────────────────────────────────────────────────────

def pct(n, d):
    return f"{n/d*100:.1f}%" if d else "n/a"

def ts_to_iso(ts):
    """Handle both unix-ms int and ISO string timestamps."""
    if isinstance(ts, (int, float)):
        return datetime.fromtimestamp(ts/1000, tz=timezone.utc).strftime("%Y-%m-%d %H:%M")
    return str(ts)[:16]

# ─── per-profile analysis ─────────────────────────────────────────────────────

for profile, label in PROFILES.items():

    print("=" * 72)
    print(f"  PROFILE: {profile}  ({label})")
    print("=" * 72)

    # ── all fills with side + token + intent reason ───────────────────────────
    cur.execute("""
        SELECT f.ts, f.price, f.size, i.side, i.tokenId, i.reason,
               o.ts as order_ts
        FROM Fill f
        JOIN [Order] o ON f.orderId = o.id
        JOIN CopyIntent i ON o.intentId = i.id
        WHERE i.profileId = ?
        ORDER BY f.ts
    """, (profile,))
    fills = cur.fetchall()

    if not fills:
        print("  (no fills yet)\n")
        continue

    # ── aggregate per token ───────────────────────────────────────────────────
    tokens = defaultdict(lambda: {
        "buy_notional": 0, "sell_notional": 0,
        "buy_shares": 0,   "sell_shares": 0,
        "buy_prices": [],  "sell_prices": [],
        "buy_ts": [],      "sell_ts": [],
        "reason": None,
    })

    for ts, price, size, side, token_id, reason, order_ts in fills:
        t = tokens[token_id]
        notional = price * size
        if side == "BUY":
            t["buy_notional"] += notional
            t["buy_shares"]   += size
            t["buy_prices"].append(price)
            t["buy_ts"].append(ts)
        else:
            t["sell_notional"] += notional
            t["sell_shares"]   += size
            t["sell_prices"].append(price)
            t["sell_ts"].append(ts)
            if reason:
                t["reason"] = reason

    # ── get market titles from LeaderEvents ───────────────────────────────────
    token_ids = list(tokens.keys())
    titles = {}
    if token_ids:
        placeholders = ",".join("?" * len(token_ids))
        cur.execute(f"""
            SELECT tokenId, rawJson FROM LeaderEvent
            WHERE profileId=? AND tokenId IN ({placeholders})
            GROUP BY tokenId
        """, [profile] + token_ids)
        for tok, raw in cur.fetchall():
            try:
                d = json.loads(raw)
                t = d.get("title") or d.get("question") or ""
                if t:
                    titles[tok] = t.strip()
            except Exception:
                pass

    # ── get skip/reject counts ────────────────────────────────────────────────
    cur.execute("""
        SELECT status, reason, COUNT(*) FROM CopyIntent
        WHERE profileId=? AND status IN ('SKIPPED','REJECTED')
        GROUP BY status, reason ORDER BY COUNT(*) DESC
    """, (profile,))
    skip_rows = cur.fetchall()

    # ── build closed trade rows ───────────────────────────────────────────────
    closed_trades = []
    open_trades   = []

    for tok, t in tokens.items():
        buy_shares  = t["buy_shares"]
        sell_shares = t["sell_shares"]
        avg_buy     = t["buy_notional"] / buy_shares if buy_shares else 0
        avg_sell    = t["sell_notional"] / sell_shares if sell_shares else 0
        pnl         = t["sell_notional"] - t["buy_notional"]  # full cost vs proceeds
        title       = titles.get(tok, tok[-20:])[:55]

        # Hold time: first buy → last sell
        hold_s = None
        if t["buy_ts"] and t["sell_ts"]:
            # timestamps can be iso strings or ms ints
            def to_ms(v):
                if isinstance(v, (int, float)): return v
                return datetime.fromisoformat(str(v).replace("Z","+00:00")).timestamp()*1000
            buy_ms  = min(to_ms(x) for x in t["buy_ts"])
            sell_ms = max(to_ms(x) for x in t["sell_ts"])
            hold_s  = (sell_ms - buy_ms) / 1000

        net_shares = round(buy_shares - sell_shares, 4)
        is_closed  = (net_shares < 0.01)
        exit_src   = t.get("reason") or ("SELL_FILL" if t["sell_prices"] else "OPEN")

        row = {
            "tok": tok, "title": title,
            "avg_buy": avg_buy, "avg_sell": avg_sell,
            "buy_notional": t["buy_notional"], "sell_notional": t["sell_notional"],
            "pnl": pnl, "hold_s": hold_s,
            "exit_src": exit_src, "is_closed": is_closed,
            "buy_shares": buy_shares,
        }
        if is_closed:
            closed_trades.append(row)
        else:
            open_trades.append(row)

    # ─── 1. SUMMARY ──────────────────────────────────────────────────────────
    total_buy  = sum(t["buy_notional"]  for t in tokens.values())
    total_sell = sum(t["sell_notional"] for t in tokens.values())
    realized   = sum(r["pnl"] for r in closed_trades)
    wins       = [r for r in closed_trades if r["pnl"] > 0]
    losses     = [r for r in closed_trades if r["pnl"] <= 0]
    cash_now   = STARTING_USDC - total_buy + total_sell

    print(f"\n{'─'*60}")
    print(f"  1. SUMMARY")
    print(f"{'─'*60}")
    print(f"  Starting cash       : ${STARTING_USDC:.2f}")
    print(f"  Cash now (hydrated) : ${cash_now:.4f}  ({'+' if cash_now>=STARTING_USDC else ''}{cash_now-STARTING_USDC:.4f})")
    print(f"  Total BUY notional  : ${total_buy:.2f}")
    print(f"  Total SELL notional : ${total_sell:.2f}")
    print(f"  Closed trades       : {len(closed_trades)}  ({len(wins)} wins / {len(losses)} losses)")
    print(f"  Open trades         : {len(open_trades)}")
    print(f"  Win rate            : {pct(len(wins), len(closed_trades))}")
    print(f"  Realized P&L        : ${realized:.4f}")
    if wins:
        print(f"  Avg win P&L         : ${sum(r['pnl'] for r in wins)/len(wins):.4f}")
    if losses:
        print(f"  Avg loss P&L        : ${sum(r['pnl'] for r in losses)/len(losses):.4f}")

    # ─── 2. PRICE BAND ANALYSIS ──────────────────────────────────────────────
    print(f"\n{'─'*60}")
    print(f"  2. PRICE BAND ANALYSIS (avg buy price at entry)")
    print(f"{'─'*60}")
    bands = [(0.55,0.70,"0.55-0.70"),(0.70,0.80,"0.70-0.80"),(0.80,0.90,"0.80-0.90"),
             (0.90,0.95,"0.90-0.95"),(0.95,0.99,"0.95-0.99"),(0.99,1.0,"0.99-1.00")]
    print(f"  {'Band':<12} {'Trades':>7} {'Wins':>6} {'Losses':>7} {'WinRate':>8} {'AvgPnL':>9} {'TotalPnL':>10}")
    for lo, hi, name in bands:
        band_trades = [r for r in closed_trades if lo <= r["avg_buy"] < hi]
        bw = [r for r in band_trades if r["pnl"] > 0]
        bl = [r for r in band_trades if r["pnl"] <= 0]
        if not band_trades:
            continue
        avg_pnl = sum(r["pnl"] for r in band_trades) / len(band_trades)
        tot_pnl = sum(r["pnl"] for r in band_trades)
        print(f"  {name:<12} {len(band_trades):>7} {len(bw):>6} {len(bl):>7} {pct(len(bw),len(band_trades)):>8} {avg_pnl:>+9.4f} {tot_pnl:>+10.4f}")

    # ─── 3. EXIT SOURCE ──────────────────────────────────────────────────────
    print(f"\n{'─'*60}")
    print(f"  3. EXIT SOURCE (how positions were closed)")
    print(f"{'─'*60}")
    exit_counts = defaultdict(lambda: {"count":0,"pnl":0,"wins":0})
    for r in closed_trades:
        src = r["exit_src"] or "SELL_FILL"
        exit_counts[src]["count"] += 1
        exit_counts[src]["pnl"]   += r["pnl"]
        if r["pnl"] > 0:
            exit_counts[src]["wins"] += 1
    print(f"  {'Exit Source':<25} {'Count':>6} {'WinRate':>8} {'TotalPnL':>10}")
    for src, d in sorted(exit_counts.items(), key=lambda x: -x[1]["count"]):
        print(f"  {src:<25} {d['count']:>6} {pct(d['wins'],d['count']):>8} {d['pnl']:>+10.4f}")

    # ─── 4. HOLD TIME ANALYSIS ───────────────────────────────────────────────
    print(f"\n{'─'*60}")
    print(f"  4. HOLD TIME ANALYSIS")
    print(f"{'─'*60}")
    timed = [r for r in closed_trades if r["hold_s"] is not None]
    buckets = [(0,300,"<5min"),(300,1800,"5-30min"),(1800,7200,"30min-2h"),
               (7200,86400,"2h-1d"),(86400,9999999,">1d")]
    print(f"  {'Hold Time':<14} {'Count':>6} {'WinRate':>8} {'AvgPnL':>9} {'TotalPnL':>10}")
    for lo, hi, name in buckets:
        bt = [r for r in timed if lo <= r["hold_s"] < hi]
        if not bt:
            continue
        bw = [r for r in bt if r["pnl"] > 0]
        avg_pnl = sum(r["pnl"] for r in bt) / len(bt)
        tot_pnl = sum(r["pnl"] for r in bt)
        print(f"  {name:<14} {len(bt):>6} {pct(len(bw),len(bt)):>8} {avg_pnl:>+9.4f} {tot_pnl:>+10.4f}")

    # ─── 5. MARKET KEYWORD ANALYSIS ──────────────────────────────────────────
    print(f"\n{'─'*60}")
    print(f"  5. MARKET KEYWORD ANALYSIS (title keywords)")
    print(f"{'─'*60}")
    keyword_groups = {
        "Game 1 / Map 1":    r"game 1|map 1\b",
        "Game 2 / Map 2":    r"game 2|map 2\b",
        "Game 3 / Map 3":    r"game 3|map 3\b",
        "Match Winner (BO)": r"\bbo[35]\b|match winner",
        "Odd/Even kills":    r"odd.?even|odd or even",
        "Total kills":       r"total kills",
        "Over/Under":        r"over.?under|\bou\b",
        "Score/Series":      r"series|score",
        "LoL":               r"\blol\b|league of legends",
        "CS:GO/CS2":         r"\bcs2?\b|counter.strike",
        "CoD":               r"call of duty|\bcod\b|\bcodm",
        "Valorant":          r"valorant",
        "Sports (other)":    r"nba|nfl|nhl|mlb|soccer|football|basketball",
    }
    print(f"  {'Category':<25} {'Trades':>7} {'Wins':>6} {'WinRate':>8} {'TotalPnL':>10}")
    for cat, pattern in keyword_groups.items():
        matched = [r for r in closed_trades if re.search(pattern, r["title"], re.I)]
        if not matched:
            continue
        mw = [r for r in matched if r["pnl"] > 0]
        tot = sum(r["pnl"] for r in matched)
        print(f"  {cat:<25} {len(matched):>7} {len(mw):>6} {pct(len(mw),len(matched)):>8} {tot:>+10.4f}")

    # ─── 6. WORST & BEST TRADES ──────────────────────────────────────────────
    print(f"\n{'─'*60}")
    print(f"  6. BEST 5 TRADES")
    print(f"{'─'*60}")
    for r in sorted(closed_trades, key=lambda x: -x["pnl"])[:5]:
        hs = f"{int(r['hold_s']//3600)}h{int((r['hold_s']%3600)//60)}m" if r["hold_s"] else "?"
        print(f"  P&L={r['pnl']:+.4f}  buy={r['avg_buy']:.4f}  sell={r['avg_sell']:.4f}  hold={hs}  {r['title'][:50]}")
    print(f"\n{'─'*60}")
    print(f"  7. WORST 5 TRADES")
    print(f"{'─'*60}")
    for r in sorted(closed_trades, key=lambda x: x["pnl"])[:5]:
        hs = f"{int(r['hold_s']//3600)}h{int((r['hold_s']%3600)//60)}m" if r["hold_s"] else "?"
        print(f"  P&L={r['pnl']:+.4f}  buy={r['avg_buy']:.4f}  sell={r['avg_sell']:.4f}  hold={hs}  {r['title'][:50]}")

    # ─── 8. OPEN POSITIONS ───────────────────────────────────────────────────
    if open_trades:
        print(f"\n{'─'*60}")
        print(f"  8. OPEN POSITIONS ({len(open_trades)})")
        print(f"{'─'*60}")
        for r in sorted(open_trades, key=lambda x: -x["buy_notional"]):
            print(f"  cost=${r['buy_notional']:.2f}  entry={r['avg_buy']:.4f}  {r['title'][:55]}")

    # ─── 9. SKIP/REJECT REASONS ──────────────────────────────────────────────
    if skip_rows:
        print(f"\n{'─'*60}")
        print(f"  9. TOP SKIP/REJECT REASONS")
        print(f"{'─'*60}")
        total_skipped = sum(r[2] for r in skip_rows)
        for status, reason, count in skip_rows[:10]:
            print(f"  {status:<10} {reason or '(none)':<35} {count:>6}  ({pct(count,total_skipped)})")

    print()

conn.close()
print("\nAnalysis complete.")
