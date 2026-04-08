import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const tables = ["LeaderEvent", "CopyIntent", "Order", "Fill", "Position", "Alert", "RuntimeMetric", "ConfigVersion"];

for (const table of tables) {
  const tableSql = table === "Order" ? '"Order"' : table;
  const rows = await prisma.$queryRawUnsafe(`SELECT profileId, COUNT(*) AS c FROM ${tableSql} GROUP BY profileId ORDER BY c DESC`);
  console.log(`\n${table}`);
  if (rows.length === 0) {
    console.log("(none)");
  } else {
    for (const r of rows) {
      console.log(`${r.profileId} ${r.c}`);
    }
  }
}

await prisma.$disconnect();
