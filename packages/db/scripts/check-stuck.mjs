/**
 * Check and optionally fix stuck PLACED intents + current paused state
 */
import { PrismaClient } from '@prisma/client';
const dbPath = 'C:/Users/Rico/new-bot-GPT/packages/db/prisma/dev.db';
const p = new PrismaClient({ datasources: { db: { url: `file:${dbPath}` } } });

// Find stuck PLACED intents for live profile
const placed = await p.copyIntent.findMany({
  where: { profileId: 'live', status: 'PLACED' },
  select: { id: true, ts: true, tokenId: true, desiredNotional: true }
});
console.log(`Stuck PLACED intents (live): ${placed.length}`);
placed.forEach(i => console.log(`  ${i.ts.toLocaleString('en-GB')}  notional=$${Number(i.desiredNotional).toFixed(2)}`));

// Current active config (paused state)
const activeCfg = await p.configVersion.findFirst({
  where: { profileId: 'live', active: true },
  orderBy: { createdAt: 'desc' }
});
if (activeCfg) {
  const cfg = JSON.parse(activeCfg.json);
  console.log(`\nCurrent active config: paused=${JSON.stringify(cfg.runtime?.paused)}  kill=${JSON.stringify(cfg.runtime?.killSwitch)}`);
  console.log(`Last updated: ${activeCfg.createdAt.toLocaleString('en-GB')}`);
}

// Paper profiles too
for (const pid of ['paper-v2', 'paper-v3']) {
  const pPlaced = await p.copyIntent.count({ where: { profileId: pid, status: 'PLACED' } });
  const pCfg = await p.configVersion.findFirst({ where: { profileId: pid, active: true }, orderBy: { createdAt: 'desc' } });
  const cfg = pCfg ? JSON.parse(pCfg.json) : {};
  console.log(`\n${pid}: stuck PLACED=${pPlaced}  config paused=${cfg.runtime?.paused}`);
}

await p.$disconnect();
