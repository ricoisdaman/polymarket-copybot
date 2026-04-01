import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

// Find recent WARN/ERROR alerts that could have triggered kill switch
const alerts = await db.alert.findMany({
  orderBy: { ts: "desc" },
  take: 40,
  where: { severity: { in: ["WARN", "ERROR"] } },
});

console.log(`\n=== Recent WARN/ERROR Alerts (newest first) ===`);
for (const a of alerts) {
  const t = new Date(a.ts);
  console.log(`${t.toLocaleString()}  [${a.severity}]  ${a.code}  —  ${a.message.slice(0, 100)}`);
}

// Also check what the current runtime control state is
const rc = await db.runtimeControl.findFirst();
console.log(`\n=== Current Runtime Control ===`);
console.log(rc);

await db.$disconnect();
