import path from 'path';
import { fileURLToPath } from 'url';
import { PrismaClient } from './packages/db/node_modules/@prisma/client/index.js';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbUrl = 'file:' + path.resolve(__dirname, './packages/db/prisma/dev.db').replace(/\\/g,'/');
const prisma = new PrismaClient({datasources:{db:{url:dbUrl}}});

// Check fill distribution by side and profile
const res = await prisma.$queryRawUnsafe(`SELECT o.side, f.profileId, COUNT(*) as cnt FROM Fill f JOIN "Order" o ON f.orderId = o.id GROUP BY o.side, f.profileId ORDER BY f.profileId, o.side`);
console.log('Fill by side:');
for (const r of res) console.log(`  ${r.profileId} ${r.side}: ${r.cnt}`);

// Check order side distribution  
const orders = await prisma.$queryRawUnsafe(`SELECT side, profileId, COUNT(*) as cnt FROM "Order" GROUP BY side, profileId ORDER BY profileId, side`);
console.log('\nOrders by side:');
for (const r of orders) console.log(`  ${r.profileId} ${r.side}: ${r.cnt}`);

// Check if paper-v2 has any SELL orders
const paperSells = await prisma.$queryRawUnsafe(`SELECT COUNT(*) as cnt FROM "Order" WHERE side='SELL' AND profileId='paper-v2'`);
console.log('\nPaper-v2 SELL orders:', Number(paperSells[0].cnt));

await prisma.$disconnect();
