import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const tokenPrefix = "token-";

  const [placeholderPositions, placeholderIntents, placeholderLeaderEvents] = await Promise.all([
    prisma.position.findMany({
      where: { tokenId: { startsWith: tokenPrefix } },
      select: { tokenId: true }
    }),
    prisma.copyIntent.findMany({
      where: { tokenId: { startsWith: tokenPrefix } },
      select: { id: true }
    }),
    prisma.leaderEvent.findMany({
      where: { tokenId: { startsWith: tokenPrefix } },
      select: { id: true }
    })
  ]);

  const placeholderIntentIds = placeholderIntents.map((item) => item.id);

  const placeholderOrders =
    placeholderIntentIds.length > 0
      ? await prisma.order.findMany({
          where: { intentId: { in: placeholderIntentIds } },
          select: { id: true }
        })
      : [];

  const placeholderOrderIds = placeholderOrders.map((item) => item.id);

  const before = {
    positions: placeholderPositions.length,
    intents: placeholderIntentIds.length,
    orders: placeholderOrderIds.length,
    fills:
      placeholderOrderIds.length > 0
        ? await prisma.fill.count({ where: { orderId: { in: placeholderOrderIds } } })
        : 0,
    leaderEvents: placeholderLeaderEvents.length
  };

  const deleted = await prisma.$transaction(async (tx) => {
    const deletedFills =
      placeholderOrderIds.length > 0
        ? await tx.fill.deleteMany({ where: { orderId: { in: placeholderOrderIds } } })
        : { count: 0 };

    const deletedOrders =
      placeholderOrderIds.length > 0
        ? await tx.order.deleteMany({ where: { id: { in: placeholderOrderIds } } })
        : { count: 0 };

    const deletedIntents =
      placeholderIntentIds.length > 0
        ? await tx.copyIntent.deleteMany({ where: { id: { in: placeholderIntentIds } } })
        : { count: 0 };

    const deletedPositions = await tx.position.deleteMany({
      where: { tokenId: { startsWith: tokenPrefix } }
    });

    const deletedEvents = await tx.leaderEvent.deleteMany({
      where: { tokenId: { startsWith: tokenPrefix } }
    });

    return {
      positions: deletedPositions.count,
      intents: deletedIntents.count,
      orders: deletedOrders.count,
      fills: deletedFills.count,
      leaderEvents: deletedEvents.count
    };
  });

  const postCheck = {
    positions: await prisma.position.count({ where: { tokenId: { startsWith: tokenPrefix } } }),
    intents: await prisma.copyIntent.count({ where: { tokenId: { startsWith: tokenPrefix } } }),
    leaderEvents: await prisma.leaderEvent.count({ where: { tokenId: { startsWith: tokenPrefix } } })
  };

  console.log(
    JSON.stringify(
      {
        tokenPrefix,
        before,
        deleted,
        postCheck
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
