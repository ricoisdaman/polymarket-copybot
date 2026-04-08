/**
 * Live diagnostic — queries DB directly via better-sqlite3 to avoid Prisma env issues
 */
import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dir = dirname(fileURLToPath(import.meta.url));
const dbPath = join(__dir, '../prisma/dev.db');
const db = new Database(dbPath, { readonly: true });

function sep(label) {
  console.log('\n' + '═'.repeat(72));
  console.log('  ' + label);
  console.log('═'.repeat(72));
}

const now = Date.now();
const h12 = new Date(now - 12 * 60 * 60 * 1000).toISOString();
const h24 = new Date(now - 24 * 60 * 60 * 1000).toISOString();
const h48 = new Date(now - 48 * 60 * 60 * 1000).toISOString();

// ── 1. Runtime control ─────────────────────────────────────────────────────────
sep('1. RUNTIME CONTROL STATE');
try {
  const rc = db.prepare('SELECT profileId, paused, killSwitch, updatedAt FROM RuntimeControl ORDER BY updatedAt DESC').all();
  if (rc.length === 0) console.log('  (no rows — table may be named differently)');
  rc.forEach(r => console.log(`  ${r.profileId.padEnd(14)} paused=${r.paused}  kill=${r.killSwitch}  updatedAt=${r.updatedAt}`));
} catch(e) {
  // Try alternate table name
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
    console.log('  Tables:', tables.map(t => t.name).join(', '));
  } catch(e2) { console.log('  Error:', e2.message); }
}

// ── 2. Recent fills ────────────────────────────────────────────────────────────
sep('2. FILLS — last 24h (all profiles)');
try {
  const fills = db.prepare(`
    SELECT profileId, side, price, size, filledAt, conditionId
    FROM Fill
    WHERE filledAt > ?
    ORDER BY filledAt DESC
    LIMIT 50
  `).all(h24);
  if (fills.length === 0) {
    console.log('  No fills in last 24h');
  } else {
    fills.forEach(f => {
      const time = new Date(f.filledAt).toLocaleTimeString('en-GB');
      console.log(`  ${time}  ${f.profileId.padEnd(14)} ${f.side.padEnd(4)} price=${Number(f.price).toFixed(3)}  size=${f.size}`);
    });
  }
} catch(e) { console.log('  Error:', e.message); }

// ── 3. Alerts ─────────────────────────────────────────────────────────────────
sep('3. ALERTS — last 24h');
try {
  const alerts = db.prepare(`
    SELECT profileId, level, type, message, createdAt
    FROM Alert
    WHERE createdAt > ?
    ORDER BY createdAt DESC
    LIMIT 30
  `).all(h24);
  if (alerts.length === 0) {
    console.log('  No alerts in last 24h');
  } else {
    alerts.forEach(a => {
      const time = new Date(a.createdAt).toLocaleTimeString('en-GB');
      console.log(`  ${time}  ${a.profileId.padEnd(14)} [${a.level}] ${a.type}: ${a.message}`);
    });
  }
} catch(e) { console.log('  Error:', e.message); }

// ── 4. Skip reasons with timestamps ───────────────────────────────────────────
sep('4. SKIP REASONS — live, last 24h (with timestamps for pauses)');
try {
  // PAUSED skips with timestamps to find when pauses happen
  const pauses = db.prepare(`
    SELECT reason, ts, createdAt
    FROM CopyIntent
    WHERE profileId = 'live'
      AND status = 'SKIPPED'
      AND reason IN ('PAUSED', 'DRAWDOWN_STOP', 'KILL_SWITCH')
      AND ts > ?
    ORDER BY ts DESC
    LIMIT 40
  `).all(h24);

  if (pauses.length === 0) {
    console.log('  No PAUSED/DRAWDOWN_STOP/KILL_SWITCH skips in last 24h');
  } else {
    console.log('  Recent pause-type skips:');
    pauses.forEach(s => {
      const time = new Date(s.ts).toLocaleTimeString('en-GB');
      console.log(`  ${time}  reason=${s.reason}`);
    });
  }

  // Overall skip reason counts
  const counts = db.prepare(`
    SELECT reason, COUNT(*) as cnt
    FROM CopyIntent
    WHERE profileId = 'live'
      AND status = 'SKIPPED'
      AND ts > ?
    GROUP BY reason
    ORDER BY cnt DESC
  `).all(h24);
  console.log('\n  Overall skip counts (live, 24h):');
  counts.forEach(c => console.log(`    ${c.reason.padEnd(30)} ${c.cnt}`));
} catch(e) { console.log('  Error:', e.message); }

// ── 5. Metrics ────────────────────────────────────────────────────────────────
sep('5. RUNTIME METRICS (live)');
try {
  const metrics = db.prepare(`
    SELECT key, value, updatedAt
    FROM RuntimeMetric
    WHERE profileId = 'live'
    ORDER BY key
  `).all();
  metrics.forEach(m => {
    const age = m.updatedAt ? Math.round((now - new Date(m.updatedAt).getTime()) / 1000) : null;
    const ageStr = age !== null ? ` (${age}s ago)` : '';
    console.log(`  ${m.key.padEnd(35)} = ${m.value}${ageStr}`);
  });
} catch(e) { console.log('  Error:', e.message); }

// ── 6. Config versions ────────────────────────────────────────────────────────
sep('6. ACTIVE CONFIG VERSIONS');
try {
  const configs = db.prepare(`
    SELECT profileId, config, isActive, createdAt
    FROM ConfigVersion
    WHERE isActive = 1
    ORDER BY profileId
  `).all();
  configs.forEach(c => {
    const cfg = JSON.parse(c.config);
    const b = cfg.budget || {};
    const f = cfg.filters || {};
    console.log(`  ${c.profileId}: drawdownCap=$${b.maxDailyDrawdownUSDC}  minP=${f.minPrice}  maxP=${f.maxPrice}  perTrade=$${b.perTradeNotionalUSDC}  updatedAt=${c.createdAt}`);
  });
} catch(e) { console.log('  Error:', e.message); }

// ── 7. What triggered each pause — look for surrounding DRAWDOWN_STOP events
sep('7. PAUSE TRIGGER ANALYSIS — sequence around pause skips (live)');
try {
  // Get the distinct timestamps when bot switched from trading to paused
  // by finding PAUSED skips after FILLED intents
  const recent = db.prepare(`
    SELECT reason, ts, status, desiredNotional
    FROM CopyIntent
    WHERE profileId = 'live'
      AND ts > ?
    ORDER BY ts ASC
  `).all(h48);

  let lastStatus = null;
  let pauseTransitions = [];
  for (const r of recent) {
    if (lastStatus === 'FILLED' && r.status === 'SKIPPED' && r.reason === 'PAUSED') {
      pauseTransitions.push(r.ts);
    }
    lastStatus = r.status;
  }

  if (pauseTransitions.length === 0) {
    console.log('  No FILLED→PAUSED transitions found in last 48h');
  } else {
    console.log(`  Found ${pauseTransitions.length} pause transition(s):`);
    pauseTransitions.forEach(ts => console.log(`    ${new Date(ts).toLocaleString('en-GB')}`));
  }

  // Also show the last 5 filled intents with timestamps
  const lastFills = db.prepare(`
    SELECT ts, reason, desiredNotional, desiredPrice
    FROM CopyIntent
    WHERE profileId = 'live' AND status = 'FILLED' AND ts > ?
    ORDER BY ts DESC LIMIT 10
  `).all(h48);
  console.log(`\n  Last ${lastFills.length} FILLED intents (live, 48h):`);
  lastFills.forEach(f => console.log(`    ${new Date(f.ts).toLocaleString('en-GB')}  notional=$${Number(f.desiredNotional).toFixed(2)}  price=${Number(f.desiredPrice).toFixed(3)}`));
} catch(e) { console.log('  Error:', e.message); }

db.close();
console.log('\n✔ Done');
