import { PrismaClient, Prisma } from '@prisma/client';
const p = new PrismaClient();

// Show what DB file we're connected to
const result = await p.$queryRaw`SELECT database() as db` .catch(() => null);

// Get all table names in the SQLite DB
const tables = await p.$queryRaw`SELECT name, type FROM sqlite_master WHERE type='table' ORDER BY name`;
console.log('Tables in DB:');
tables.forEach(t => console.log(' ', t.name));

// Count rows in known tables
for (const table of ['Fill', 'CopyIntent', 'RuntimeMetric', 'ConfigVersion', 'Alert', 'LeaderEvent']) {
  try {
    const count = await p.$queryRawUnsafe(`SELECT COUNT(*) as cnt FROM "${table}"`);
    console.log(`  ${table}: ${count[0].cnt} rows`);
  } catch(e) {
    console.log(`  ${table}: ERROR - ${e.message.split('\n')[0]}`);
  }
}

await p.$disconnect();
