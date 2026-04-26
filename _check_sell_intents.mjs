import path from 'path';
import { fileURLToPath } from 'url';
import { PrismaClient } from './packages/db/node_modules/@prisma/client/index.js';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbUrl = 'file:' + path.resolve(__dirname, './packages/db/prisma/dev.db').replace(/\\/g,'/');
const prisma = new PrismaClient({datasources:{db:{url:dbUrl}}});

// Find SELL orders and check if their intents have leaderEventIds
const sellOrders = await prisma.$queryRawUnsafe(`
  SELECT o.id as orderId, o.intentId, o.side, o.profileId,
         ci.leaderEventId, ci.tokenId,
         CASE WHEN le.id IS NULL THEN 'NO_LE' ELSE 'HAS_LE' END as leStatus
  FROM "Order" o
  JOIN CopyIntent ci ON o.intentId = ci.id
  LEFT JOIN LeaderEvent le ON ci.leaderEventId = le.id
  WHERE o.side = 'SELL' AND o.profileId = 'paper-v2'
  LIMIT 10
`);
console.log('Sample SELL orders (paper-v2):');
for (const r of sellOrders) {
  console.log(`  orderId=${r.orderId.slice(0,8)} intentId=${r.intentId.slice(0,8)} leaderEventId=${r.leaderEventId?.slice(0,8)} leStatus=${r.leStatus} tokenId=${r.tokenId?.slice(0,8)}`);
}

// Count how many SELL orders have valid vs missing LeaderEvents
const sellStats = await prisma.$queryRawUnsafe(`
  SELECT 
    CASE WHEN le.id IS NULL THEN 'NO_LEADER_EVENT' ELSE 'HAS_LEADER_EVENT' END as le_status,
    COUNT(*) as cnt
  FROM "Order" o
  JOIN CopyIntent ci ON o.intentId = ci.id
  LEFT JOIN LeaderEvent le ON ci.leaderEventId = le.id
  WHERE o.side = 'SELL' AND o.profileId = 'paper-v2'
  GROUP BY le_status
`);
console.log('\nSELL orders with/without LeaderEvent (paper-v2):');
for (const r of sellStats) console.log(`  ${r.le_status}: ${r.cnt}`);

// What does the LeaderEvent look like for a SELL CopyIntent?
const sellIntents = await prisma.$queryRawUnsafe(`
  SELECT ci.id, ci.side, ci.tokenId, ci.leaderEventId, le.side as leSide, le.rawJson
  FROM CopyIntent ci
  LEFT JOIN LeaderEvent le ON ci.leaderEventId = le.id
  WHERE ci.side = 'SELL' AND ci.profileId = 'paper-v2'
  LIMIT 5
`);
console.log('\nSample SELL CopyIntents (paper-v2):');
for (const r of sellIntents) {
  const rj = r.rawJson ? JSON.parse(r.rawJson) : {};
  console.log(`  ciId=${r.id.slice(0,8)} ciSide=${r.side} leId=${r.leaderEventId?.slice(0,8)} leSide=${r.leSide} slug=${rj.slug || 'n/a'}`);
}

await prisma.$disconnect();
