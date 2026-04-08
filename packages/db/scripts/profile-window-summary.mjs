import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
const hours = Number(process.argv[2] ?? 120);
const since = new Date(Date.now() - hours * 60 * 60 * 1000);

const profiles = await prisma.$queryRawUnsafe(
  `SELECT profileId,
          (SELECT COUNT(*) FROM LeaderEvent le WHERE le.profileId = p.profileId AND le.ts >= ?) AS leaderEvents,
          (SELECT COUNT(*) FROM CopyIntent ci WHERE ci.profileId = p.profileId AND ci.ts >= ?) AS intents,
          (SELECT COUNT(*) FROM Fill f WHERE f.profileId = p.profileId AND f.ts >= ?) AS fills,
          (SELECT COUNT(*) FROM Alert a WHERE a.profileId = p.profileId AND a.ts >= ?) AS alerts
   FROM (
     SELECT profileId FROM ConfigVersion
     UNION SELECT profileId FROM LeaderEvent
     UNION SELECT profileId FROM CopyIntent
     UNION SELECT profileId FROM Fill
     UNION SELECT profileId FROM Alert
     UNION SELECT profileId FROM Position
     UNION SELECT profileId FROM RuntimeMetric
   ) p
   ORDER BY fills DESC, intents DESC, leaderEvents DESC`,
  since, since, since, since
);

for (const r of profiles) {
  const cfg = await prisma.$queryRawUnsafe(
    `SELECT json FROM ConfigVersion WHERE profileId = ? AND active = 1 ORDER BY createdAt DESC LIMIT 1`,
    r.profileId
  );
  let mode = "?";
  let perTrade = "?";
  if (cfg.length) {
    try {
      const j = JSON.parse(cfg[0].json);
      mode = j.mode ?? "?";
      perTrade = j?.budget?.perTradeNotionalUSDC ?? "?";
    } catch {
      // ignore
    }
  }
  console.log(`${r.profileId.padEnd(10)} mode=${String(mode).padEnd(5)} perTrade=${String(perTrade).padEnd(4)} events=${String(r.leaderEvents).padStart(5)} intents=${String(r.intents).padStart(5)} fills=${String(r.fills).padStart(4)} alerts=${String(r.alerts).padStart(4)}`);
}

await prisma.$disconnect();
