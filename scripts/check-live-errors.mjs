// Run from packages/db: node scripts/check-live-errors.mjs
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
const alerts = await prisma.alert.findMany({
  where: { code: 'LIVE_EXECUTION_ERROR' },
  orderBy: { createdAt: 'desc' },
  take: 5,
});
if (alerts.length === 0) {
  console.log('No LIVE_EXECUTION_ERROR alerts found.');
} else {
  for (const a of alerts) {
    console.log(a.createdAt.toISOString());
    console.log(JSON.stringify(a.meta, null, 2));
    console.log('---');
  }
}
await prisma.$disconnect();
