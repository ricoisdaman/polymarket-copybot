import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const since = new Date(Date.now() - 12 * 60 * 60 * 1000);

  const [
    events,
    intents,
    fills,
    orders,
    alerts,
    runtimeMetrics,
    statusGrouped,
    skippedReasonsGrouped
  ] = await Promise.all([
    prisma.leaderEvent.findMany({ where: { ts: { gte: since } }, orderBy: { ts: "desc" }, take: 20 }),
    prisma.copyIntent.findMany({ where: { ts: { gte: since } }, orderBy: { ts: "desc" }, take: 100 }),
    prisma.fill.findMany({ where: { ts: { gte: since } }, orderBy: { ts: "desc" }, take: 20 }),
    prisma.order.findMany({ where: { ts: { gte: since } }, orderBy: { ts: "desc" }, take: 20 }),
    prisma.alert.findMany({ where: { ts: { gte: since } }, orderBy: { ts: "desc" }, take: 50 }),
    prisma.runtimeMetric.findMany({ orderBy: { key: "asc" } }),
    prisma.copyIntent.groupBy({ by: ["status"], where: { ts: { gte: since } }, _count: { _all: true } }),
    prisma.copyIntent.groupBy({ by: ["reason"], where: { ts: { gte: since }, status: "SKIPPED" }, _count: { _all: true } })
  ]);

  const metricsMap = Object.fromEntries(runtimeMetrics.map((item) => [item.key, { value: item.value, updatedAt: item.updatedAt }]));
  const selectedMetrics = {
    "bot.feed.events_seen": metricsMap["bot.feed.events_seen"] ?? null,
    "bot.feed.last_event_ts": metricsMap["bot.feed.last_event_ts"] ?? null,
    "bot.feed.last_poll_ts": metricsMap["bot.feed.last_poll_ts"] ?? null,
    "bot.feed.last_error": metricsMap["bot.feed.last_error"] ?? null,
    "bot.queue_depth": metricsMap["bot.queue_depth"] ?? null,
    "bot.cash_usdc": metricsMap["bot.cash_usdc"] ?? null,
    "bot.drawdown_usdc": metricsMap["bot.drawdown_usdc"] ?? null,
    "bot.heartbeat_ts": metricsMap["bot.heartbeat_ts"] ?? null
  };

  const statusCounts = Object.fromEntries(statusGrouped.map((row) => [row.status, row._count._all]));
  const skipReasonCounts = Object.fromEntries(skippedReasonsGrouped.map((row) => [row.reason ?? "UNKNOWN", row._count._all]));

  console.log(
    JSON.stringify(
      {
        since,
        counts: {
          events: events.length,
          intents: intents.length,
          orders: orders.length,
          fills: fills.length,
          alerts: alerts.length
        },
        statusCounts,
        skipReasonCounts,
        selectedMetrics,
        latestEvent: events[0] ?? null,
        latestIntent: intents[0] ?? null,
        latestFill: fills[0] ?? null,
        latestAlert: alerts[0] ?? null
      },
      null,
      2
    )
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
