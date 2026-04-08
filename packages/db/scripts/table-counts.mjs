import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
const tables = ["ConfigVersion", "LeaderCursor", "LeaderEvent", "CopyIntent", '"Order"', "Fill", "Position", "Alert", "RuntimeMetric"];
for (const t of tables) {
  const rows = await prisma.$queryRawUnsafe(`SELECT COUNT(*) AS c FROM ${t}`);
  console.log(`${t} ${rows[0].c}`);
}
await prisma.$disconnect();
