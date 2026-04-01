import { PrismaClient } from "@prisma/client";
const db = new PrismaClient();
const alerts = await db.alert.findMany({
  where: { code: "LIVE_EXECUTION_ERROR" },
  orderBy: { ts: "desc" },
  take: 5,
});
if (alerts.length === 0) {
  console.log("No LIVE_EXECUTION_ERROR alerts found.");
} else {
  for (const a of alerts) {
    console.log(new Date(a.ts).toLocaleTimeString(), JSON.stringify(JSON.parse(a.contextJson)));
  }
}
await db.$disconnect();
