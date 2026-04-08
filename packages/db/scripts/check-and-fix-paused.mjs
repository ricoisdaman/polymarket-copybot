import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

// Check all profiles with non-default paused state
const rows = await db.configVersion.findMany({
  orderBy: { createdAt: 'desc' },
  take: 30
});

for (const r of rows) {
  const cfg = JSON.parse(r.json);
  const safety = cfg.safety ?? {};
  if (safety.paused || safety.killSwitch) {
    console.log(`profile=${r.profileId} active=${r.active} paused=${safety.paused} killSwitch=${safety.killSwitch} created=${r.createdAt}`);
  }
}

// Fix leader2 - find its most recent row regardless of active flag
const leader2 = await db.configVersion.findFirst({
  where: { profileId: 'leader2' },
  orderBy: { createdAt: 'desc' }
});

if (leader2) {
  const cfg = JSON.parse(leader2.json);
  console.log('\nLeader2 most recent config:');
  console.log('  id:', leader2.id, 'active:', leader2.active, 'paused:', cfg.safety?.paused);

  if (cfg.safety?.paused) {
    cfg.safety.paused = false;
    cfg.safety.killSwitch = false;
    await db.configVersion.update({
      where: { id: leader2.id },
      data: { json: JSON.stringify(cfg), active: true }
    });
    console.log('  -> Cleared paused state and set active=true');
  }
} else {
  console.log('\nNo ConfigVersion rows for leader2 at all');
}

await db.$disconnect();
