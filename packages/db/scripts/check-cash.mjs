import { PrismaClient } from "@prisma/client";
const db = new PrismaClient();

const metrics = await db.runtimeMetric.findMany({
  where: { key: { in: ["bot.cash_usdc", "bot.drawdown_usdc", "bot.daily_notional_usdc"] } }
});
for (const m of metrics) console.log(m.key, "=", m.value);

await db.$disconnect();
