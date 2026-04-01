import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

const profileId = process.argv[2] ?? 'leader2';

// Find the current active config for this profile
const current = await db.configVersion.findFirst({
  where: { profileId, active: true },
  orderBy: { createdAt: 'desc' }
});

if (!current) {
  console.log(`No active ConfigVersion for profile '${profileId}', nothing to do.`);
  await db.$disconnect();
  process.exit(0);
}

const cfg = JSON.parse(current.json);
console.log('Current state:', { paused: cfg.safety?.paused, killSwitch: cfg.safety?.killSwitch });

if (!cfg.safety?.paused && !cfg.safety?.killSwitch) {
  console.log('Already unpaused, nothing to do.');
  await db.$disconnect();
  process.exit(0);
}

// Set paused=false, killSwitch=false
cfg.safety = { ...cfg.safety, paused: false, killSwitch: false };

await db.configVersion.updateMany({
  where: { profileId, active: true },
  data: { json: JSON.stringify(cfg) }
});

console.log(`Profile '${profileId}' unpaused successfully.`);
await db.$disconnect();
