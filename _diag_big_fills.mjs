import path from 'path';
import { fileURLToPath } from 'url';
import { PrismaClient } from './packages/db/node_modules/@prisma/client/index.js';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbUrl = 'file:' + path.resolve(__dirname, './packages/db/prisma/dev.db').replace(/\\/g,'/');
const prisma = new PrismaClient({datasources:{db:{url:dbUrl}}});

// Find the Ostapenko trade and any fills > $4 on live profile
const bigFills = await prisma.$queryRawUnsafe(`
  SELECT 
    f.ts, f.price, f.size, ROUND(f.price * f.size, 4) as usdcValue,
    o.side, o.status,
    ci.desiredNotional, ci.leaderSize, ci.profileId,
    le.rawJson
  FROM Fill f
  JOIN "Order" o ON f.orderId = o.id
  JOIN CopyIntent ci ON o.intentId = ci.id
  JOIN LeaderEvent le ON ci.leaderEventId = le.id
  WHERE f.profileId = 'live'
    AND (f.price * f.size) > 3.5
  ORDER BY f.ts DESC
`);

console.log(`=== Live fills > $3.50 (all time) ===\n`);
if (bigFills.length === 0) {
  console.log('None found in live profile via LeaderEvent join.');
} else {
  for (const f of bigFills) {
    const rj = f.rawJson ? JSON.parse(f.rawJson) : {};
    console.log(`${new Date(f.ts).toISOString().slice(0,16)} | ${f.side} | $${Number(f.usdcValue).toFixed(4)} | ${Number(f.price).toFixed(3)} x ${Number(f.size).toFixed(2)} shares | leaderSize=$${f.leaderSize} | desiredNotional=$${f.desiredNotional} | ${(rj.title||'').slice(0,50)}`);
  }
}

// Also check all profiles for Ostapenko
const ostapenko = await prisma.$queryRawUnsafe(`
  SELECT 
    f.ts, f.price, f.size, ROUND(f.price * f.size, 4) as usdcValue,
    o.side, f.profileId as fProfile,
    ci.desiredNotional, ci.leaderSize,
    le.rawJson
  FROM Fill f
  JOIN "Order" o ON f.orderId = o.id
  JOIN CopyIntent ci ON o.intentId = ci.id
  JOIN LeaderEvent le ON ci.leaderEventId = le.id
  WHERE le.rawJson LIKE '%Ostapenko%'
  ORDER BY f.ts DESC
`);

console.log(`\n=== All Ostapenko fills (any profile) ===\n`);
for (const f of ostapenko) {
  const rj = f.rawJson ? JSON.parse(f.rawJson) : {};
  console.log(`${new Date(f.ts).toISOString().slice(0,16)} | ${f.fProfile} | ${f.side} | $${Number(f.usdcValue).toFixed(4)} | ${Number(f.price).toFixed(3)} x ${Number(f.size).toFixed(2)} shares | leaderSize=$${f.leaderSize} | desiredNotional=$${f.desiredNotional} | ${(rj.title||'').slice(0,60)}`);
}

// Also look at ALL live fills ever and find the max
const maxFill = await prisma.$queryRawUnsafe(`
  SELECT MAX(f.price * f.size) as maxVal, COUNT(*) as total
  FROM Fill f
  WHERE f.profileId = 'live'
`);
console.log(`\nLive profile: max fill value = $${Number(maxFill[0].maxVal).toFixed(4)}, total fills = ${maxFill[0].total}`);

// Distribution of fill sizes for live
const dist = await prisma.$queryRawUnsafe(`
  SELECT 
    CASE 
      WHEN f.price * f.size < 1.0 THEN '<$1'
      WHEN f.price * f.size < 2.0 THEN '$1-2'
      WHEN f.price * f.size < 3.0 THEN '$2-3'
      WHEN f.price * f.size < 4.0 THEN '$3-4'
      WHEN f.price * f.size < 6.0 THEN '$4-6'
      WHEN f.price * f.size < 9.0 THEN '$6-9'
      ELSE '$9+'
    END as bucket,
    COUNT(*) as cnt,
    o.side
  FROM Fill f
  JOIN "Order" o ON f.orderId = o.id
  WHERE f.profileId = 'live'
  GROUP BY bucket, o.side
  ORDER BY o.side, bucket
`);
console.log('\nLive fill size distribution:');
for (const r of dist) console.log(`  ${r.side} | ${r.bucket}: ${r.cnt}`);

await prisma.$disconnect();
