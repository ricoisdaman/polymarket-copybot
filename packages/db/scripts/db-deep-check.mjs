import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();

// Check everything in sqlite_master
const all = await p.$queryRaw`SELECT type, name, tbl_name FROM sqlite_master ORDER BY type, name`;
console.log('All DB objects:');
all.forEach(o => console.log(`  ${o.type.padEnd(8)} ${o.name}`));

// Check page count and size
const pageInfo = await p.$queryRaw`PRAGMA page_count`;
const pageSize = await p.$queryRaw`PRAGMA page_size`;
console.log(`\nDB size: ${pageInfo[0].page_count} pages × ${pageSize[0].page_size} bytes = ${(pageInfo[0].page_count * pageSize[0].page_size / 1024 / 1024).toFixed(1)} MB`);

// Check WAL mode
const walMode = await p.$queryRaw`PRAGMA journal_mode`;
console.log('Journal mode:', walMode[0].journal_mode);

// Check freelist (deleted/unused pages)
const freeList = await p.$queryRaw`PRAGMA freelist_count`;
console.log('Freelist pages:', freeList[0].freelist_count);

// Try to get actual row counts from some tables with raw SQLite queries
const fillCount = await p.$queryRaw`SELECT COUNT(*) as n FROM "Fill"`;
const ciCount = await p.$queryRaw`SELECT COUNT(*) as n FROM "CopyIntent"`;
console.log(`\nFill rows: ${fillCount[0].n}, CopyIntent rows: ${ciCount[0].n}`);

// Check if there's data that's been deleted (auto_vacuum)
const autoVacuum = await p.$queryRaw`PRAGMA auto_vacuum`;
console.log('Auto vacuum:', autoVacuum[0].auto_vacuum);

// Check the _prisma_migrations table
try {
  const migs = await p.$queryRaw`SELECT id, migration_name, finished_at FROM "_prisma_migrations" ORDER BY finished_at DESC LIMIT 5`;
  console.log('\nPrisma migrations:', JSON.stringify(migs));
} catch(e) {
  console.log('\nNo _prisma_migrations table:', e.message.split('\n')[0]);
}

await p.$disconnect();
