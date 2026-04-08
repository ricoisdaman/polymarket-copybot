import { PrismaClient } from '@prisma/client';
const p = new PrismaClient({ datasources: { db: { url: 'file:C:/Users/Rico/new-bot-GPT/packages/db/prisma/dev.db' } } });
const r = await p.runtimeMetric.updateMany({
  where: { profileId: 'live', key: 'bot.live_starting_usdc' },
  data: { value: '60' }
});
console.log('Updated', r.count, 'rows');
const m = await p.runtimeMetric.findFirst({ where: { profileId: 'live', key: 'bot.live_starting_usdc' } });
console.log('Now:', m?.value);
await p.$disconnect();
