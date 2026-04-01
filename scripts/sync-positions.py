"""
sync-positions.py — One-shot position reconciler.
Fetches actual on-chain positions from Polymarket Gamma API and zeros out any
local DB positions that no longer exist on-chain (resolved markets, sold positions).

Usage (from project root):
    python scripts/sync-positions.py [--wallet 0x...]

The wallet address is read from .env (POLYMARKET_PROXY_WALLET or POLYMARKET_WALLET_ADDRESS).
You can also pass it directly with --wallet.
"""
import sqlite3
import json
import urllib.request
import sys
import os
import re

DB_PATH = os.path.join(os.path.dirname(__file__), '..', 'packages', 'db', 'prisma', 'dev.db')
PROFILE = 'default'

def read_env():
    env_path = os.path.join(os.path.dirname(__file__), '..', '.env')
    env = {}
    if os.path.exists(env_path):
        with open(env_path, 'r') as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith('#') and '=' in line:
                    k, _, v = line.partition('=')
                    env[k.strip()] = v.strip().strip('"').strip("'")
    return env

def fetch_gamma_positions(wallet_address):
    url = f"https://data-api.polymarket.com/positions?user={wallet_address}"
    print(f"Fetching positions from Data API for wallet {wallet_address[:10]}...")
    req = urllib.request.Request(url, headers={"User-Agent": "copybot/1.0"})
    with urllib.request.urlopen(req, timeout=10) as resp:
        data = json.loads(resp.read())
    result = {}
    redeemable_count = 0
    for item in data:
        token_id = str(item.get('asset', '')).strip()
        size = float(item.get('size', 0) or 0)
        # Positions with redeemable=True are from resolved markets — treat as closed
        if item.get('redeemable'):
            redeemable_count += 1
            continue
        if token_id and size > 0.0001:
            result[token_id] = size
    print(f"  Total API positions: {len(data)}, resolved/redeemable: {redeemable_count}, active: {len(result)}")
    return result

def main():
    env = read_env()

    # Determine wallet address
    wallet = None
    for i, arg in enumerate(sys.argv[1:]):
        if arg == '--wallet' and i + 1 < len(sys.argv) - 1:
            wallet = sys.argv[i + 2]
        elif arg.startswith('0x'):
            wallet = arg

    if not wallet:
        wallet = env.get('POLYMARKET_PROXY_WALLET') or env.get('POLYMARKET_WALLET_ADDRESS')

    if not wallet:
        print("ERROR: No wallet address found. Pass --wallet 0x... or set POLYMARKET_PROXY_WALLET in .env")
        sys.exit(1)

    print(f"Wallet: {wallet}")

    # Fetch on-chain positions
    try:
        on_chain = fetch_gamma_positions(wallet)
    except Exception as e:
        print(f"ERROR fetching Gamma API: {e}")
        sys.exit(1)

    print(f"On-chain open positions: {len(on_chain)}")

    # Get local DB open positions
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute("SELECT tokenId, size FROM Position WHERE profileId=? AND size > 0", (PROFILE,))
    db_positions = c.fetchall()

    print(f"Local DB open positions: {len(db_positions)}")

    # Find stale positions (in DB but not on-chain)
    to_zero = [(tok, sz) for tok, sz in db_positions if tok not in on_chain]
    still_open = [(tok, sz) for tok, sz in db_positions if tok in on_chain]

    print(f"\nStill open on-chain: {len(still_open)}")
    print(f"Stale (to zero): {len(to_zero)}")

    if to_zero:
        print("\nZeroing stale positions:")
        for tok, sz in to_zero:
            print(f"  {tok[:30]}... (was {sz:.4f} shares)")

        confirm = input(f"\nZero {len(to_zero)} stale positions? [y/N] ").strip().lower()
        if confirm == 'y':
            stale_ids = [tok for tok, _ in to_zero]
            placeholders = ','.join(['?'] * len(stale_ids))
            c.execute(
                f"UPDATE Position SET size=0, updatedAt=datetime('now') WHERE profileId=? AND tokenId IN ({placeholders})",
                [PROFILE] + stale_ids
            )
            conn.commit()
            print(f"Done. Zeroed {c.rowcount} positions.")
        else:
            print("Aborted.")
    else:
        print("\nNo stale positions to zero — DB is already in sync.")

    conn.close()

if __name__ == '__main__':
    main()
