import Database from 'better-sqlite3';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = resolve(__dirname, '../packages/db/prisma/dev.db');
const db = new Database(dbPath, { readonly: true });

// Kill switch state
console.log('=== CONFIG / KILL SWITCH ===');
const cfg = db.prepare("SELECT json FROM ConfigVersion WHERE active=1 ORDER BY createdAt DESC LIMIT 1").get();
if (cfg) {
  const c = JSON.parse(cfg.json);
  console.log('  killSwitch:', c.safety?.killSwitch, '  paused:', c.safety?.paused);
} else {
  console.log('  no active config');
}

// Recent errors
console.log('\n=== RECENT LIVE_EXECUTION_ERRORs (last 10) ===');
const errs = db.prepare("SELECT ts, contextJson FROM Alert WHERE code='LIVE_EXECUTION_ERROR' ORDER BY ts DESC LIMIT 10").all();
if (errs.length === 0) console.log('  none');
errs.forEach(r => {
  const meta = JSON.parse(r.contextJson);
  console.log(' ', new Date(r.ts).toLocaleTimeString(), meta.error?.slice(0, 140));
});

// Recent error storms
console.log('\n=== ERROR STORMS (last 5) ===');
const storms = db.prepare("SELECT ts, message FROM Alert WHERE code='ERROR_STORM' ORDER BY ts DESC LIMIT 5").all();
if (storms.length === 0) console.log('  none');
storms.forEach(r => console.log(' ', new Date(r.ts).toLocaleTimeString(), r.message));

// Intent summary
console.log('\n=== INTENT TOTALS ===');
db.prepare("SELECT status, reason, COUNT(*) as n FROM CopyIntent GROUP BY status, reason ORDER BY n DESC LIMIT 20").all()
  .forEach(r => console.log(' ', String(r.n).padStart(6), r.status, r.reason ?? ''));

// Fills
console.log('\n=== RECENT FILLS (last 20) ===');
const fills = db.prepare(`
  SELECT ci.ts, ci.side, ci.tokenId, f.price, f.size
  FROM CopyIntent ci
  JOIN CopyOrder co ON co.intentId = ci.id
  JOIN Fill f ON f.orderId = co.id
  ORDER BY ci.ts DESC LIMIT 20
`).all();
if (fills.length === 0) console.log('  none');
fills.forEach(r => {
  const notional = (r.price * r.size).toFixed(2);
  console.log(' ', new Date(r.ts).toLocaleTimeString(), r.side.padEnd(4), 'price:', String(r.price).padEnd(6), 'size:', String(r.size).padEnd(8), 'USDC:', notional);
});

// Total spend vs position value estimate
const totalBuyNotional = db.prepare("SELECT COALESCE(SUM(f.price * f.size), 0) as total FROM CopyIntent ci JOIN CopyOrder co ON co.intentId=ci.id JOIN Fill f ON f.orderId=co.id WHERE ci.side='BUY'").get();
const totalSellNotional = db.prepare("SELECT COALESCE(SUM(f.price * f.size), 0) as total FROM CopyIntent ci JOIN CopyOrder co ON co.intentId=ci.id JOIN Fill f ON f.orderId=co.id WHERE ci.side='SELL'").get();
console.log('\n=== SPEND SUMMARY ===');
console.log('  Total BUY  USDC spent:    $' + Number(totalBuyNotional.total).toFixed(2));
console.log('  Total SELL USDC received: $' + Number(totalSellNotional.total).toFixed(2));
console.log('  Net USDC out (open risk):  $' + (totalBuyNotional.total - totalSellNotional.total).toFixed(2));

db.close();
