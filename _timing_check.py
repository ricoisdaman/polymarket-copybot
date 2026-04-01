import sqlite3
from datetime import datetime, timezone

DB = "packages/db/prisma/dev.db"
c = sqlite3.connect(DB)
c.row_factory = sqlite3.Row

events = c.execute("""
    SELECT le.id, le.tokenId, le.price, le.ts,
           json_extract(le.rawJson,'$.title') as title
    FROM LeaderEvent le
    WHERE le.profileId='live' AND LOWER(le.rawJson) LIKE '%miami%'
    ORDER BY le.ts ASC
""").fetchall()

hb = 1774478355595
t_4h = hb - 4*3600*1000
t_5h = hb - 5*3600*1000

token_info = {}
for e in events:
    tok = e['tokenId']
    ts = e['ts'] if isinstance(e['ts'], int) else int(e['ts'])
    if tok not in token_info:
        token_info[tok] = {'prices': [], 'timestamps': [], 'ids': []}
    token_info[tok]['prices'].append(e['price'])
    token_info[tok]['timestamps'].append(ts)
    token_info[tok]['ids'].append(e['id'])

print("Token analysis (all Miami Open tokens in DB):")
for tok, info in sorted(token_info.items(), key=lambda x: min(x[1]['timestamps'])):
    ps = info['prices']
    ts_list = info['timestamps']
    short = tok[-20:]
    first_dt = datetime.fromtimestamp(min(ts_list)/1000, tz=timezone.utc).strftime('%H:%M UTC')
    last_dt = datetime.fromtimestamp(max(ts_list)/1000, tz=timezone.utc).strftime('%H:%M UTC')
    print(f"  ...{short}: n={len(ps):3d}  min={min(ps):.3f}  max={max(ps):.3f}  first={first_dt}  last={last_dt}")

all_ts = [e['ts'] if isinstance(e['ts'], int) else int(e['ts']) for e in events]
first_event_dt = datetime.fromtimestamp(min(all_ts)/1000, tz=timezone.utc)
dt_4h = datetime.fromtimestamp(t_4h/1000, tz=timezone.utc)
dt_5h = datetime.fromtimestamp(t_5h/1000, tz=timezone.utc)
dt_hb = datetime.fromtimestamp(hb/1000, tz=timezone.utc)

print()
print(f"Bot heartbeat (now):               {dt_hb.strftime('%H:%M UTC')}")
print(f"Screenshot 76c trade (4h ago):     {dt_4h.strftime('%H:%M UTC')}")
print(f"Screenshot 70c trade (5h ago):     {dt_5h.strftime('%H:%M UTC')}")
print(f"Earliest ANY Miami event in DB:    {first_event_dt.strftime('%H:%M UTC')}")
print()
print(f"Were 76c/70c trades BEFORE bot started tracking Miami Open?")
print(f"  5h ago = {dt_5h.strftime('%H:%M')} | earliest event = {first_event_dt.strftime('%H:%M')} | missed = {min(all_ts) > t_5h}")
print(f"  4h ago = {dt_4h.strftime('%H:%M')} | earliest event = {first_event_dt.strftime('%H:%M')} | missed = {min(all_ts) > t_4h}")

print()
print("Events in the 0.70-0.80 sweet spot:")
sweet = [e for e in events if 0.70 <= e['price'] <= 0.80]
if sweet:
    for e in sweet:
        ts = e['ts'] if isinstance(e['ts'], int) else int(e['ts'])
        dt = datetime.fromtimestamp(ts/1000, tz=timezone.utc)
        ci = c.execute(
            "SELECT status, reason FROM CopyIntent WHERE leaderEventId=?", (e['id'],)
        ).fetchone()
        ci_str = f"{ci['status']} / {ci['reason']}" if ci else "NO INTENT CREATED"
        print(f"  {dt.strftime('%H:%M:%S UTC')}  price={e['price']:.4f}  {ci_str}  token=...{e['tokenId'][-16:]}")
else:
    print("  NONE - the bot never received a leader event at 70-80c for this market")

c.close()
