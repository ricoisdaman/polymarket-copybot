import sqlite3
from datetime import datetime, timezone

DB = "packages/db/prisma/dev.db"
c = sqlite3.connect(DB)
c.row_factory = sqlite3.Row

print("=" * 70)
print("  DEEP DIVE: MIAMI OPEN EVENT TIMELINE")
print("=" * 70)

# Convert ts 1774478355595 (heartbeat) to human time for reference
hb_utc = datetime.fromtimestamp(1774478355595 / 1000, tz=timezone.utc)
print(f"\n  Heartbeat (now):  {hb_utc.strftime('%Y-%m-%d %H:%M:%S UTC')}")
print(f"  4h ago trade was: {datetime.fromtimestamp((1774478355595 - 4*3600*1000)/1000, tz=timezone.utc).strftime('%H:%M UTC')}")
print(f"  5h ago trade was: {datetime.fromtimestamp((1774478355595 - 5*3600*1000)/1000, tz=timezone.utc).strftime('%H:%M UTC')}")

# All Miami Open events with human timestamps
print("\n--- ALL Miami Open leader events (full timeline) ---")
events = c.execute("""
    SELECT le.ts, le.tokenId, le.side, le.price,
           json_extract(le.rawJson,'$.title') as title
    FROM LeaderEvent le
    WHERE le.profileId='live' AND LOWER(le.rawJson) LIKE '%miami%'
    ORDER BY le.ts ASC
""").fetchall()

two_token_ids = set()
for e in events:
    ts_ms = e['ts'] if isinstance(e['ts'], int) else int(e['ts'])
    try:
        dt = datetime.fromtimestamp(ts_ms / 1000, tz=timezone.utc)
        ts_str = dt.strftime('%H:%M:%S UTC')
    except:
        ts_str = str(e['ts'])
    two_token_ids.add(e['tokenId'])
    short_token = e['tokenId'][-12:] if e['tokenId'] else '?'
    print(f"  {ts_str}  side={e['side']}  price={e['price']:.4f}  token=...{short_token}")

print(f"\n  Total Miami Open events: {len(events)}")
print(f"  Unique tokens: {len(two_token_ids)}")

# The two tokens
token_list = list(two_token_ids)
print(f"\n--- Price ranges per token ---")
for tok in sorted(token_list):
    tok_events = [e for e in events if e['tokenId'] == tok]
    prices = [e['price'] for e in tok_events]
    short = tok[-16:]
    print(f"  ...{short}: min={min(prices):.4f}  max={max(prices):.4f}  count={len(tok_events)}")

# Check if there's ANY leader event for this market with price 0.70-0.80
print("\n--- Events in the 0.70-0.80 range (what we WANT to copy) ---")
sweet_spot = [e for e in events if 0.70 <= e['price'] <= 0.80]
if sweet_spot:
    for e in sweet_spot:
        ts_ms = e['ts'] if isinstance(e['ts'], int) else int(e['ts'])
        dt = datetime.fromtimestamp(ts_ms / 1000, tz=timezone.utc)
        print(f"  {dt.strftime('%H:%M:%S UTC')}  price={e['price']:.4f}")
else:
    print("  NONE — the bot never saw this market at 70-80¢ in its polling window")

# Check the leader cursor to understand when polling started/where it is
print("\n--- Leader cursor state ---")
cursor = c.execute("""
    SELECT * FROM LeaderCursor
    WHERE profileId='live'
""").fetchall()
for row in cursor:
    print(f"  wallet={row['leaderWallet'][:20]}...  lastSeenKey={row['lastSeenActivityKey']}  updated={row['updatedAt']}")

# Check when the bot last had fills (to understand uptime gaps)
print("\n--- Fill timestamps (all time, most recent 5) ---")
fills = c.execute("""
    SELECT f.ts, f.price, o.side,
           COALESCE(json_extract(le.rawJson,'$.title'), ci.tokenId) as title
    FROM Fill f
    JOIN "Order" o ON o.id = f.orderId
    JOIN CopyIntent ci ON ci.id = o.intentId
    JOIN LeaderEvent le ON le.id = ci.leaderEventId
    WHERE f.profileId='live'
    ORDER BY f.ts DESC
    LIMIT 5
""").fetchall()
for f in fills:
    ts_ms = f['ts'] if isinstance(f['ts'], int) else int(f['ts'])
    try:
        dt = datetime.fromtimestamp(ts_ms / 1000, tz=timezone.utc)
        ts_str = dt.strftime('%Y-%m-%d %H:%M UTC')
    except:
        ts_str = str(f['ts'])
    print(f"  {ts_str}  {f['side']}  ${f['price']:.4f}  {(f['title'] or '')[:40]}")

# Check for any gap in leader event polling (look at event frequency)
print("\n--- Gap analysis: time between oldest and newest Miami event ---")
if events:
    first_ts = events[0]['ts'] if isinstance(events[0]['ts'], int) else int(events[0]['ts'])
    last_ts = events[-1]['ts'] if isinstance(events[-1]['ts'], int) else int(events[-1]['ts'])
    first_dt = datetime.fromtimestamp(first_ts / 1000, tz=timezone.utc)
    last_dt = datetime.fromtimestamp(last_ts / 1000, tz=timezone.utc)
    print(f"  First Miami event: {first_dt.strftime('%H:%M:%S UTC')}")
    print(f"  Last Miami event:  {last_dt.strftime('%H:%M:%S UTC')}")
    gap_min = (last_ts - first_ts) / 60000
    print(f"  Span: {gap_min:.1f} minutes")

# When did the 5h-ago and 4h-ago trades happen relative to bot's event log?
target_5h = 1774478355595 - 5*3600*1000
target_4h = 1774478355595 - 4*3600*1000
print(f"\n  Bot's oldest Miami event was at: {first_dt.strftime('%H:%M UTC')}")
print(f"  The 76¢ trade (4h ago) was at:  {datetime.fromtimestamp(target_4h/1000, tz=timezone.utc).strftime('%H:%M UTC')}")
print(f"  The 70¢ trade (5h ago) was at:  {datetime.fromtimestamp(target_5h/1000, tz=timezone.utc).strftime('%H:%M UTC')}")

before_70 = target_5h < (events[0]['ts'] if isinstance(events[0]['ts'], int) else int(events[0]['ts']))
before_76 = target_4h < (events[0]['ts'] if isinstance(events[0]['ts'], int) else int(events[0]['ts']))
print(f"\n  Was the 70¢ trade BEFORE the bot's earliest event? {'YES →  bot missed it' if before_70 else 'No — bot was polling'}")
print(f"  Was the 76¢ trade BEFORE the bot's earliest event? {'YES → bot missed it' if before_76 else 'No — bot was polling'}")

c.close()
