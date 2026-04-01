"""
Diagnose the both-sides-copy problem for leader2.
Shows: games where we copied both outcomes, net per-game result,
and what we'd have made copying only the first signal per game.
"""
import sqlite3, json
from collections import defaultdict
from datetime import datetime, timezone

DB = "packages/db/prisma/dev.db"
conn = sqlite3.connect(DB)
cur = conn.cursor()

def ts_str(ts):
    if isinstance(ts, (int, float)):
        return datetime.fromtimestamp(ts / 1000, tz=timezone.utc).strftime("%m-%d %H:%M")
    try:
        return str(datetime.fromisoformat(str(ts).replace("Z","+00:00")).strftime("%m-%d %H:%M"))
    except Exception:
        return str(ts)[:16]

def to_ms(ts):
    if isinstance(ts, (int, float)): return ts
    try: return datetime.fromisoformat(str(ts).replace("Z","+00:00")).timestamp() * 1000
    except Exception: return 0

# ── All leader2 fills with conditionId ──────────────────────────────────────
cur.execute("""
    SELECT f.ts, f.price, f.size, i.side, i.tokenId,
           COALESCE(le.conditionId, i.tokenId) as conditionId,
           i.reason,
           ROUND(f.price * f.size, 4) as notional
    FROM Fill f
    JOIN [Order] o ON f.orderId = o.id
    JOIN CopyIntent i ON o.intentId = i.id
    LEFT JOIN LeaderEvent le ON le.id = i.leaderEventId
    WHERE i.profileId = 'leader2'
    ORDER BY f.ts
""")
all_fills = cur.fetchall()

# Market titles
token_ids = list(set(r[4] for r in all_fills))
titles = {}
if token_ids:
    ph = ",".join("?"*len(token_ids))
    cur.execute(f"SELECT tokenId, rawJson FROM LeaderEvent WHERE profileId='leader2' AND tokenId IN ({ph}) GROUP BY tokenId", token_ids)
    for tok, raw in cur.fetchall():
        try:
            d = json.loads(raw)
            t = d.get("title") or d.get("question") or ""
            titles[tok] = t.strip()
        except Exception:
            pass

# ── Group by conditionId to find both-sides games ───────────────────────────
condition_tokens = defaultdict(set)
token_fills = defaultdict(list)
for row in all_fills:
    ts, price, size, side, tid, cid, reason, notional = row
    condition_tokens[cid].add(tid)
    token_fills[tid].append(row)

both_sides_conditions = {cid: toks for cid, toks in condition_tokens.items() if len(toks) >= 2}

print(f"Total conditions traded   : {len(condition_tokens)}")
print(f"Both-sides games (>=2 tok): {len(both_sides_conditions)}")
print()

both_sides_pnl     = 0.0
single_side_pnl    = 0.0
hypothetical_pnl   = 0.0   # if we'd skipped the second token per game below

# ── Analyse per condition ────────────────────────────────────────────────────
print("=" * 80)
print("BOTH-SIDES GAMES — what we actually made vs what single-side would have made")
print("=" * 80)

both_sides_wins = 0
both_sides_losses = 0
hypothetical_wins = 0
hypothetical_losses = 0

for cid, token_set in sorted(both_sides_conditions.items()):
    token_list = list(token_set)
    # Find buy timestamp for each token — take the first-bought token as "primary"
    token_first_buy = {}
    for tid in token_list:
        buys = [r for r in token_fills[tid] if r[3] == "BUY"]
        if buys:
            token_first_buy[tid] = min(to_ms(r[0]) for r in buys)

    if len(token_first_buy) < 2:
        continue

    sorted_tokens = sorted(token_first_buy.items(), key=lambda x: x[1])
    primary_tid   = sorted_tokens[0][0]
    secondary_tid = sorted_tokens[1][0]
    primary_first_buy_ts   = sorted_tokens[0][1]
    secondary_first_buy_ts = sorted_tokens[1][1]
    delay_minutes = (secondary_first_buy_ts - primary_first_buy_ts) / 60000

    game_pnl = 0.0
    token_summaries = []
    for tid in token_list:
        buys  = [r for r in token_fills[tid] if r[3] == "BUY"]
        sells = [r for r in token_fills[tid] if r[3] == "SELL"]
        cost     = sum(r[7] for r in buys)
        proceeds = sum(r[7] for r in sells) if sells else 0
        tok_pnl  = proceeds - cost
        game_pnl += tok_pnl
        is_primary = (tid == primary_tid)
        entry_price = sum(r[1] for r in buys) / len(buys) if buys else 0
        exit_price  = sum(r[1] for r in sells) / len(sells) if sells else None
        token_summaries.append({
            "tid": tid, "title": titles.get(tid, tid[-20:])[:42],
            "cost": cost, "proceeds": proceeds, "pnl": tok_pnl,
            "entry": entry_price, "exit": exit_price,
            "is_primary": is_primary, "is_open": not sells
        })

    primary_data = next(s for s in token_summaries if s["is_primary"])
    hyp_pnl = primary_data["pnl"]  # what we'd have made with only the primary bet
    is_open = any(s["is_open"] for s in token_summaries)

    if not is_open:
        both_sides_pnl  += game_pnl
        hypothetical_pnl += hyp_pnl
        if game_pnl > 0: both_sides_wins += 1
        else: both_sides_losses += 1
        if hyp_pnl > 0: hypothetical_wins += 1
        else: hypothetical_losses += 1

    # Print
    status = "(OPEN)" if is_open else ""
    print(f"\n  Game: {primary_data['title'].split(' vs')[0]}... vs ... [{delay_minutes:.0f}min gap between legs] {status}")
    print(f"  {'TOK':<6} {'Title':<44} {'Entry':>7} {'Exit':>7} {'P&L':>8} {'Role'}")
    for s in sorted(token_summaries, key=lambda x: -x["is_primary"]):
        role = "PRIMARY " if s["is_primary"] else "HEDGE   "
        exit_str = f"{s['exit']:.4f}" if s["exit"] else "OPEN  "
        open_flag = " *" if s["is_open"] else ""
        print(f"  {'':6} {s['title']:<44} {s['entry']:>7.4f} {exit_str:>7} {s['pnl']:>+8.4f} {role}{open_flag}")
    print(f"  NET on this game: {game_pnl:>+.4f}  │  Hypothetical (primary only): {hyp_pnl:>+.4f}")

# ── Summary ──────────────────────────────────────────────────────────────────
print()
print("=" * 80)
print("SUMMARY — BOTH-SIDES vs SINGLE-SIDE HYPOTHESIS")
print("=" * 80)

# Single-side trades
single_cids = set(condition_tokens.keys()) - set(both_sides_conditions.keys())
for cid in single_cids:
    for tid in condition_tokens[cid]:
        buys  = [r for r in token_fills[tid] if r[3] == "BUY"]
        sells = [r for r in token_fills[tid] if r[3] == "SELL"]
        if buys and sells:
            pnl = sum(r[7] for r in sells) - sum(r[7] for r in buys)
            single_side_pnl += pnl

total_realized = sum(
    sum(r[7] for r in token_fills[tid] if r[3]=="SELL") -
    sum(r[7] for r in token_fills[tid] if r[3]=="BUY")
    for tids in condition_tokens.values() for tid in tids
    if all(r[3]=="SELL" or r[3]=="BUY" for r in token_fills[tid])
)

print(f"\n  Both-sides games (closed)  : {both_sides_wins + both_sides_losses} games")
print(f"  └─ Actual net P&L          : {both_sides_pnl:>+.4f}  ({both_sides_wins}W / {both_sides_losses}L)")
print(f"  └─ Hypothetical (1st leg)  : {hypothetical_pnl:>+.4f}  ({hypothetical_wins}W / {hypothetical_losses}L)")
print(f"  └─ Difference              : {hypothetical_pnl - both_sides_pnl:>+.4f}")
print()
print(f"  Single-side games P&L      : {single_side_pnl:>+.4f}")
print()
print(f"  DIAGNOSES:")
loss_from_hedging = hypothetical_pnl - both_sides_pnl
if loss_from_hedging > 0:
    print(f"  [!] Copying the leader's HEDGE leg is costing us ~${loss_from_hedging:.2f}")
    print(f"      The leader bets both sides because they use asymmetric sizing (e.g. $5k bet, $1k hedge).")
    print(f"      We copy both sides with equal $5 bets — so when the hedge is wrong, we lose the full $5.")
    print(f"      FIX: Cap per conditionId (whole game), not per tokenId (individual outcome).")
    print(f"      This would make us copy only the leader's FIRST signal per game.")
else:
    print(f"  Both-sides copying is actually working better in this dataset.")

conn.close()
