import { PrismaClient } from "@prisma/client";
import { fileURLToPath } from "url";
import path from "path";
import { buildDefaultConfig, copybotConfigSchema, type CopybotConfig, type LeaderEvent, type TradeSide } from "@copybot/core";

export const DEFAULT_PROFILE_ID = "default";

// Always resolve dev.db absolutely from this file's own location — immune to DATABASE_URL env var
const _dbDir = path.dirname(fileURLToPath(import.meta.url));
const _absDbUrl = `file:${path.resolve(_dbDir, "../prisma/dev.db").replace(/\\/g, "/")}`;

export type DbHealth = {
  ok: boolean;
  engine: "sqlite";
};

export type NewCopyIntent = {
  leaderEventId: string;
  tokenId: string;
  side: TradeSide;
  leaderSize?: number;
  desiredNotional: number;
  desiredSize: number;
  status: string;
  reason?: string;
  mode?: string;
};

export type NewOrder = {
  intentId: string;
  side: TradeSide;
  price: number;
  size: number;
  status: string;
  clobOrderId?: string;
};

export type NewFill = {
  orderId: string;
  price: number;
  size: number;
  fee: number;
  liquiditySide: "TAKER" | "MAKER";
};

export type RuntimeControlState = {
  killSwitch: boolean;
  paused: boolean;
};

export type TimelineItem = {
  kind: "intent" | "order" | "fill";
  id: string;
  ts: string;
  tokenId?: string;
  side?: string;
  status?: string;
  price?: number;
  size?: number;
  desiredNotional?: number;
};

export type RuntimeMetricRecord = {
  key: string;
  value: string;
  updatedAt: string;
};

export type PositionSummaryRow = {
  tokenId: string;
  marketTitle: string;
  marketStatus: "OPEN" | "SOLD_OUT" | "RESOLVED" | "UNKNOWN";
  amount: number;
  shares: number;
  avgBuyPrice: number;
  currentValue: number;
  pnl: number;
  lastPrice: number;
  updatedAt: string;
};

export type PositionSummaries = {
  open: PositionSummaryRow[];
  closed: PositionSummaryRow[];
};

export function getDbHealth(): DbHealth {
  return { ok: true, engine: "sqlite" };
}

export function createDbClient(): PrismaClient {
  return new PrismaClient({ datasources: { db: { url: _absDbUrl } } });
}

export async function listProfiles(prisma: PrismaClient): Promise<string[]> {
  // Only surface profiles whose bot-worker has sent a heartbeat in the last 5 minutes.
  // This means stopped/stale profiles never appear in the dashboard.
  const cutoff = new Date(Date.now() - 5 * 60 * 1000);
  const rows = await prisma.runtimeMetric.findMany({
    where: {
      key: "bot.heartbeat_ts",
      updatedAt: { gt: cutoff }
    },
    select: { profileId: true },
    distinct: ["profileId"],
    orderBy: { profileId: "asc" }
  });
  return rows.map((r) => r.profileId);
}

export async function hasLeaderEvent(prisma: PrismaClient, profileId: string, dedupeKey: string): Promise<boolean> {
  const existing = await prisma.leaderEvent.findUnique({
    where: { profileId_dedupeKey: { profileId, dedupeKey } }
  });
  return Boolean(existing);
}

export async function saveLeaderEvent(prisma: PrismaClient, profileId: string, event: LeaderEvent): Promise<string> {
  const created = await prisma.leaderEvent.create({
    data: {
      profileId,
      dedupeKey: event.dedupeKey,
      ts: new Date(event.ts),
      leaderWallet: event.leaderWallet,
      conditionId: event.conditionId,
      tokenId: event.tokenId,
      side: event.side,
      price: event.price,
      size: event.size,
      usdcSize: event.usdcSize,
      rawJson: JSON.stringify(event.raw)
    }
  });

  await prisma.leaderCursor.upsert({
    where: { profileId_leaderWallet: { profileId, leaderWallet: event.leaderWallet } },
    update: {
      lastSeenActivityKey: event.dedupeKey,
      updatedAt: new Date()
    },
    create: {
      profileId,
      leaderWallet: event.leaderWallet,
      lastSeenActivityKey: event.dedupeKey
    }
  });

  return created.id;
}

export async function createCopyIntent(prisma: PrismaClient, profileId: string, input: NewCopyIntent): Promise<string> {
  const created = await prisma.copyIntent.create({
    data: {
      profileId,
      leaderEventId: input.leaderEventId,
      ts: new Date(),
      tokenId: input.tokenId,
      side: input.side,
      leaderSize: input.leaderSize ?? 0,
      desiredNotional: input.desiredNotional,
      desiredSize: input.desiredSize,
      status: input.status,
      reason: input.reason,
      mode: input.mode ?? "PAPER"
    }
  });
  return created.id;
}

export async function updateCopyIntentStatus(
  prisma: PrismaClient,
  intentId: string,
  status: string,
  reason?: string
): Promise<void> {
  await prisma.copyIntent.update({
    where: { id: intentId },
    data: {
      status,
      reason
    }
  });
}

export async function createOrder(prisma: PrismaClient, profileId: string, input: NewOrder): Promise<string> {
  const created = await prisma.order.create({
    data: {
      profileId,
      intentId: input.intentId,
      ts: new Date(),
      side: input.side,
      price: input.price,
      size: input.size,
      status: input.status,
      clobOrderId: input.clobOrderId,
      lastUpdate: new Date()
    }
  });
  return created.id;
}

export async function createFill(prisma: PrismaClient, profileId: string, input: NewFill): Promise<string> {
  const created = await prisma.fill.create({
    data: {
      profileId,
      orderId: input.orderId,
      ts: new Date(),
      price: input.price,
      size: input.size,
      fee: input.fee,
      liquiditySide: input.liquiditySide
    }
  });
  return created.id;
}

export async function upsertPositionDelta(
  prisma: PrismaClient,
  profileId: string,
  tokenId: string,
  side: TradeSide,
  fillSize: number,
  fillPrice: number
): Promise<void> {
  const existing = await prisma.position.findUnique({ where: { profileId_tokenId: { profileId, tokenId } } });

  if (!existing) {
    const nextSize = side === "BUY" ? fillSize : 0;
    await prisma.position.upsert({
      where: { profileId_tokenId: { profileId, tokenId } },
      update: {
        size: nextSize,
        avgPrice: fillPrice,
        updatedAt: new Date()
      },
      create: {
        profileId,
        tokenId,
        size: nextSize,
        avgPrice: fillPrice
      }
    });
    return;
  }

  if (side === "BUY") {
    const newSize = existing.size + fillSize;
    const weightedAverage = newSize > 0 ? (existing.avgPrice * existing.size + fillPrice * fillSize) / newSize : fillPrice;
    await prisma.position.update({
      where: { profileId_tokenId: { profileId, tokenId } },
      data: {
        size: newSize,
        avgPrice: weightedAverage,
        updatedAt: new Date()
      }
    });
    return;
  }

  const reducedSize = Math.max(0, existing.size - fillSize);
  await prisma.position.update({
    where: { profileId_tokenId: { profileId, tokenId } },
    data: {
      size: reducedSize,
      updatedAt: new Date()
    }
  });
}

export async function createAlert(
  prisma: PrismaClient,
  profileId: string,
  severity: "INFO" | "WARN" | "ERROR",
  code: string,
  message: string,
  context: Record<string, unknown>
): Promise<string> {
  const created = await prisma.alert.create({
    data: {
      profileId,
      ts: new Date(),
      severity,
      code,
      message,
      contextJson: JSON.stringify(context)
    }
  });
  return created.id;
}

export async function listRecentActivity(prisma: PrismaClient, profileId: string, limit = 50, skip = 0, mode?: string) {
  const modeFilter = mode ? { mode } : {};
  const where = { profileId, ...modeFilter };
  const [intents, total] = await Promise.all([
    prisma.copyIntent.findMany({
      where,
      orderBy: { ts: "desc" },
      take: limit,
      skip
    }),
    prisma.copyIntent.count({ where })
  ]);

  // Look up market titles from the linked leader events' rawJson
  const leaderEventIds = intents.map((i) => i.leaderEventId).filter(Boolean);
  const marketTitleByTokenId = new Map<string, string>();
  if (leaderEventIds.length > 0) {
    const leaderEvents = await prisma.leaderEvent.findMany({
      where: { id: { in: leaderEventIds } },
      select: { tokenId: true, rawJson: true }
    });
    for (const ev of leaderEvents) {
      if (marketTitleByTokenId.has(ev.tokenId)) continue;
      try {
        const parsed = JSON.parse(ev.rawJson) as { title?: unknown };
        const title = typeof parsed.title === "string" ? parsed.title.trim() : "";
        if (title) marketTitleByTokenId.set(ev.tokenId, title);
      } catch { continue; }
    }
  }

  const intentsWithTitles = intents.map((i) => ({
    ...i,
    marketTitle: marketTitleByTokenId.get(i.tokenId) ?? null
  }));

  return { intents: intentsWithTitles, total };
}

export async function listRecentAlerts(prisma: PrismaClient, profileId: string, limit = 50, sinceTs?: number) {
  const tsFilter = sinceTs ? { ts: { gte: new Date(sinceTs) } } : {};
  const alerts = await prisma.alert.findMany({
    where: { profileId, ...tsFilter },
    orderBy: { ts: "desc" },
    take: limit
  });
  return alerts;
}

export async function getPipelineSummary(prisma: PrismaClient, profileId: string, sinceTs?: number) {
  const tsFilter = sinceTs ? { ts: { gte: new Date(sinceTs) } } : {};
  const [leaderEvents, intents, openPositions, alerts, cashMetric, drawdownMetric, liveStartMetric, startingBalanceMetric, unredeemedMetric, equityMetric] = await Promise.all([
    prisma.leaderEvent.count({ where: { profileId, ...tsFilter } }),
    prisma.copyIntent.count({ where: { profileId, ...tsFilter } }),
    prisma.position.count({ where: { profileId, size: { gt: 0 } } }),
    prisma.alert.count({ where: { profileId, ...tsFilter } }),
    getRuntimeMetricNumber(prisma, profileId, "bot.cash_usdc"),
    getRuntimeMetricNumber(prisma, profileId, "bot.drawdown_usdc"),
    getRuntimeMetricNumber(prisma, profileId, "bot.live_mode_started_at"),
    getRuntimeMetricNumber(prisma, profileId, "bot.live_starting_usdc"),
    getRuntimeMetricNumber(prisma, profileId, "bot.unredeemed_usdc"),
    getRuntimeMetricNumber(prisma, profileId, "bot.equity_usdc")
  ]);

  const cash = cashMetric ?? 0;
  const unredeemed = unredeemedMetric ?? 0;
  // True portfolio value = cash + all position values (equity_usdc is written by the
  // reconcile loop using resolution-aware position valuation). Falls back to cash
  // + unredeemed for sessions that haven't run the new reconcile logic yet.
  const portfolioValue = equityMetric ?? (cash + unredeemed);

  return {
    leaderEvents,
    intents,
    openPositions,
    alerts,
    cashBalance: cash,
    drawdownUSDC: drawdownMetric ?? 0,
    liveStartedAt: liveStartMetric ?? null,
    // Starting balance written on first-ever LIVE boot; used by the dashboard to
    // compute lifetime P&L as portfolioValue - startingBalanceUSDC.
    // Defaults to 50 if the metric hasn't been written yet (pre-existing sessions).
    startingBalanceUSDC: startingBalanceMetric ?? 50,
    unredeemedUSDC: unredeemed,
    portfolioValue
  };
}

export async function countLeaderEventsWithoutIntent(
  prisma: PrismaClient,
  profileId: string,
  olderThanSeconds: number,
  windowSeconds = 3600
): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanSeconds * 1000);
  const windowStart = new Date(Date.now() - windowSeconds * 1000);
  const events = await prisma.leaderEvent.findMany({
    where: { profileId, ts: { gte: windowStart, lt: cutoff } },
    select: { id: true }
  });

  if (events.length === 0) {
    return 0;
  }

  const eventIds = events.map((event) => event.id);
  const linkedIntents = await prisma.copyIntent.findMany({
    where: { profileId, leaderEventId: { in: eventIds } },
    select: { leaderEventId: true }
  });

  const linked = new Set(linkedIntents.map((intent) => intent.leaderEventId));
  return eventIds.filter((id) => !linked.has(id)).length;
}

export async function isLeaderCursorStale(
  prisma: PrismaClient,
  profileId: string,
  leaderWallet: string,
  staleAfterSeconds: number
): Promise<boolean> {
  const cursor = await prisma.leaderCursor.findUnique({
    where: { profileId_leaderWallet: { profileId, leaderWallet } }
  });
  if (!cursor) {
    return true;
  }
  const ageMs = Date.now() - new Date(cursor.updatedAt).getTime();
  return ageMs > staleAfterSeconds * 1000;
}

export async function countStalePlacedIntents(prisma: PrismaClient, profileId: string, olderThanSeconds: number): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanSeconds * 1000);
  return prisma.copyIntent.count({
    where: {
      profileId,
      status: "PLACED",
      ts: { lt: cutoff }
    }
  });
}

export async function countRecentErrorAlerts(prisma: PrismaClient, profileId: string, windowSeconds: number): Promise<number> {
  const cutoff = new Date(Date.now() - windowSeconds * 1000);
  return prisma.alert.count({
    where: {
      profileId,
      severity: "ERROR",
      ts: { gte: cutoff },
      // Transient external conditions — exclude from storm count so they don't
      // kill the bot when the VPN drops or the wallet runs low.
      code: { notIn: ["GEO_RESTRICTED", "INSUFFICIENT_BALANCE"] }
    }
  });
}

function parseConfigVersion(json: string): CopybotConfig {
  const parsed = JSON.parse(json) as Partial<CopybotConfig> & {
    budget?: Partial<CopybotConfig["budget"]>;
    filters?: Partial<CopybotConfig["filters"]>;
    leader?: Partial<CopybotConfig["leader"]>;
    execution?: Partial<CopybotConfig["execution"]>;
    safety?: Partial<CopybotConfig["safety"]>;
  };
  const defaults = buildDefaultConfig();
  const normalized = {
    ...defaults,
    ...parsed,
    budget: {
      ...defaults.budget,
      ...parsed.budget
    },
    leader: {
      ...defaults.leader,
      ...parsed.leader,
      feedMode: parsed.leader?.feedMode ?? defaults.leader.feedMode,
      pollIntervalSeconds: parsed.leader?.pollIntervalSeconds ?? defaults.leader.pollIntervalSeconds
    },
    execution: {
      ...defaults.execution,
      ...parsed.execution,
      heartbeatIntervalSeconds: parsed.execution?.heartbeatIntervalSeconds ?? defaults.execution.heartbeatIntervalSeconds
    },
    safety: {
      ...defaults.safety,
      ...parsed.safety,
      paused: parsed.safety?.paused ?? defaults.safety.paused,
      botHeartbeatStaleSeconds: parsed.safety?.botHeartbeatStaleSeconds ?? defaults.safety.botHeartbeatStaleSeconds
    },
    filters: {
      ...defaults.filters,
      ...parsed.filters
    }
  };
  return copybotConfigSchema.parse(normalized);
}

export async function ensureActiveConfigVersion(prisma: PrismaClient, profileId: string, fallback?: CopybotConfig): Promise<CopybotConfig> {
  const active = await prisma.configVersion.findFirst({
    where: { profileId, active: true },
    orderBy: { createdAt: "desc" }
  });

  if (active) {
    return parseConfigVersion(active.json);
  }

  const config = fallback ?? buildDefaultConfig();
  await prisma.configVersion.create({
    data: {
      profileId,
      json: JSON.stringify(config),
      active: true
    }
  });
  return config;
}

/**
 * On worker startup, sync the persisted active config snapshot to the current env-backed
 * config while preserving runtime control flags (paused / killSwitch) from the DB.
 * This prevents stale limits from old sessions from silently overriding new env changes.
 */
export async function syncActiveConfigVersion(prisma: PrismaClient, profileId: string, fallback: CopybotConfig): Promise<CopybotConfig> {
  const active = await prisma.configVersion.findFirst({
    where: { profileId, active: true },
    orderBy: { createdAt: "desc" }
  });

  if (!active) {
    await prisma.configVersion.create({
      data: {
        profileId,
        json: JSON.stringify(fallback),
        active: true
      }
    });
    return fallback;
  }

  const current = parseConfigVersion(active.json);
  const next: CopybotConfig = {
    ...fallback,
    safety: {
      ...fallback.safety,
      killSwitch: current.safety.killSwitch,
      paused: current.safety.paused
    }
  };

  const currentJson = JSON.stringify(current);
  const nextJson = JSON.stringify(next);
  if (currentJson === nextJson) {
    return current;
  }

  await prisma.configVersion.updateMany({
    where: { profileId, active: true },
    data: { active: false }
  });

  await prisma.configVersion.create({
    data: {
      profileId,
      json: nextJson,
      active: true
    }
  });

  return next;
}

export async function getActiveControlState(prisma: PrismaClient, profileId: string, fallback?: CopybotConfig): Promise<RuntimeControlState> {
  const active = await ensureActiveConfigVersion(prisma, profileId, fallback);
  return {
    killSwitch: active.safety.killSwitch,
    paused: active.safety.paused
  };
}

export async function setRuntimeControlState(
  prisma: PrismaClient,
  profileId: string,
  patch: Partial<RuntimeControlState>,
  source: "bot-worker" | "guardian-worker" | "api-server",
  reason: string,
  fallback?: CopybotConfig
): Promise<RuntimeControlState> {
  const current = await ensureActiveConfigVersion(prisma, profileId, fallback);
  const next: CopybotConfig = {
    ...current,
    safety: {
      ...current.safety,
      killSwitch: patch.killSwitch ?? current.safety.killSwitch,
      paused: patch.paused ?? current.safety.paused
    }
  };

  await prisma.configVersion.updateMany({
    where: { profileId, active: true },
    data: { active: false }
  });

  await prisma.configVersion.create({
    data: {
      profileId,
      json: JSON.stringify(next),
      active: true
    }
  });

  await createAlert(prisma, profileId, "WARN", "RUNTIME_CONTROL_UPDATED", "Runtime control state changed", {
    source,
    reason,
    killSwitch: next.safety.killSwitch,
    paused: next.safety.paused
  });

  return {
    killSwitch: next.safety.killSwitch,
    paused: next.safety.paused
  };
}

export async function listRecentTimeline(prisma: PrismaClient, profileId: string, limit = 30, sinceTs?: number): Promise<TimelineItem[]> {
  const tsFilter = sinceTs ? { ts: { gte: new Date(sinceTs) } } : {};
  const [intents, orders, fills] = await Promise.all([
    prisma.copyIntent.findMany({
      where: { profileId, ...tsFilter },
      orderBy: { ts: "desc" },
      take: limit
    }),
    prisma.order.findMany({
      where: { profileId, ...tsFilter },
      orderBy: { ts: "desc" },
      take: limit
    }),
    prisma.fill.findMany({
      where: { profileId, ...tsFilter },
      orderBy: { ts: "desc" },
      take: limit
    })
  ]);

  const orderToIntent = new Map(orders.map((order) => [order.id, order.intentId]));
  const intentMap = new Map(intents.map((intent) => [intent.id, intent]));

  const timeline: TimelineItem[] = [
    ...intents.map((intent) => ({
      kind: "intent" as const,
      id: intent.id,
      ts: intent.ts.toISOString(),
      tokenId: intent.tokenId,
      side: intent.side,
      status: intent.status,
      desiredNotional: intent.desiredNotional,
      size: intent.desiredSize
    })),
    ...orders.map((order) => {
      const intent = intentMap.get(order.intentId);
      return {
        kind: "order" as const,
        id: order.id,
        ts: order.ts.toISOString(),
        tokenId: intent?.tokenId,
        side: order.side,
        status: order.status,
        price: order.price,
        size: order.size
      };
    }),
    ...fills.map((fill) => {
      const intentId = orderToIntent.get(fill.orderId);
      const intent = intentId ? intentMap.get(intentId) : undefined;
      return {
        kind: "fill" as const,
        id: fill.id,
        ts: fill.ts.toISOString(),
        tokenId: intent?.tokenId,
        side: intent?.side,
        price: fill.price,
        size: fill.size
      };
    })
  ];

  timeline.sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime());
  return timeline.slice(0, limit);
}

export async function setRuntimeMetric(prisma: PrismaClient, profileId: string, key: string, value: string): Promise<void> {
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await prisma.runtimeMetric.upsert({
        where: { profileId_key: { profileId, key } },
        update: { value },
        create: { profileId, key, value }
      });
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code?: unknown }).code) : "";
      const retryable = code === "P1008" || message.includes("Socket timeout") || message.includes("database is locked");
      if (!retryable || attempt === maxAttempts) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 150 * attempt));
    }
  }
}

export async function getRuntimeMetric(prisma: PrismaClient, profileId: string, key: string): Promise<RuntimeMetricRecord | null> {
  const metric = await prisma.runtimeMetric.findUnique({
    where: { profileId_key: { profileId, key } }
  });
  if (!metric) {
    return null;
  }
  return {
    key: metric.key,
    value: metric.value,
    updatedAt: metric.updatedAt.toISOString()
  };
}

export async function getRuntimeMetricNumber(prisma: PrismaClient, profileId: string, key: string): Promise<number | null> {
  const metric = await getRuntimeMetric(prisma, profileId, key);
  if (!metric) {
    return null;
  }
  const numeric = Number(metric.value);
  return Number.isFinite(numeric) ? numeric : null;
}

export async function listRuntimeMetrics(prisma: PrismaClient, profileId: string, keyPrefix: string): Promise<RuntimeMetricRecord[]> {
  const metrics = await prisma.runtimeMetric.findMany({
    where: {
      profileId,
      key: {
        startsWith: keyPrefix
      }
    },
    orderBy: {
      key: "asc"
    }
  });

  return metrics.map((item) => ({
    key: item.key,
    value: item.value,
    updatedAt: item.updatedAt.toISOString()
  }));
}

export async function getPositionSummaries(prisma: PrismaClient, profileId: string, sinceTs?: number): Promise<PositionSummaries> {
  const tsFilter = sinceTs ? { ts: { gte: new Date(sinceTs) } } : {};
  const updatedAtFilter = sinceTs ? { updatedAt: { gte: new Date(sinceTs) } } : {};
  const [fills, orders, intents, positions] = await Promise.all([
    prisma.fill.findMany({
      where: { profileId, ...tsFilter },
      orderBy: { ts: "asc" },
      select: {
        orderId: true,
        ts: true,
        price: true,
        size: true
      }
    }),
    prisma.order.findMany({
      where: { profileId },
      select: {
        id: true,
        intentId: true
      }
    }),
    prisma.copyIntent.findMany({
      where: { profileId },
      select: {
        id: true,
        tokenId: true,
        side: true
      }
    }),
    prisma.position.findMany({
      where: { profileId, ...updatedAtFilter },
      select: {
        tokenId: true,
        size: true,
        avgPrice: true,
        updatedAt: true
      }
    })
  ]);

  const orderToIntent = new Map(orders.map((item) => [item.id, item.intentId]));
  const intentById = new Map(intents.map((item) => [item.id, item]));

  const aggregates = new Map<
    string,
    {
      tokenId: string;
      openShares: number;
      openCost: number;
      totalBuyCost: number;
      totalBuyShares: number;
      totalSellNotional: number;
      realizedPnl: number;
      tradedAmount: number;
      lastPrice: number;
      updatedAt: Date;
    }
  >();

  for (const fill of fills) {
    const intentId = orderToIntent.get(fill.orderId);
    if (!intentId) {
      continue;
    }

    const intent = intentById.get(intentId);
    if (!intent) {
      continue;
    }

    const tokenId = intent.tokenId;
    const side = intent.side.toUpperCase();
    const fillNotional = fill.size * fill.price;

    const existing =
      aggregates.get(tokenId) ??
      {
        tokenId,
        openShares: 0,
        openCost: 0,
        totalBuyCost: 0,
        totalBuyShares: 0,
        totalSellNotional: 0,
        realizedPnl: 0,
        tradedAmount: 0,
        lastPrice: fill.price,
        updatedAt: fill.ts
      };

    if (side === "BUY") {
      existing.openShares += fill.size;
      existing.openCost += fillNotional;
      existing.totalBuyCost += fillNotional;
      existing.totalBuyShares += fill.size;
      existing.tradedAmount += fillNotional;
    } else {
      const averageCost = existing.openShares > 0 ? existing.openCost / existing.openShares : fill.price;
      const closeSize = Math.min(existing.openShares, fill.size);
      existing.realizedPnl += (fill.price - averageCost) * closeSize;
      existing.openShares -= closeSize;
      existing.openCost -= averageCost * closeSize;
      existing.totalSellNotional += fillNotional;
      existing.tradedAmount += fillNotional;
    }

    existing.lastPrice = fill.price;
    existing.updatedAt = fill.ts;
    aggregates.set(tokenId, existing);
  }

  // Track which tokenIds have a DB position row so we can identify fill-only orphans.
  const tokenIdsWithDbPosition = new Set(positions.map((p) => p.tokenId));

  for (const position of positions) {
    if (aggregates.has(position.tokenId)) {
      // If the DB position has been zeroed (market resolved via on-chain sync), override
      // the fill-based openShares. Without this, markets that resolved without a SELL fill
      // would remain "open" forever. The DB zero is set by syncPositionsWithOnChain in
      // bot-worker during each reconcile cycle.
      if (position.size <= 0) {
        const agg = aggregates.get(position.tokenId)!;
        if (agg.openShares > 0.001) {
          // Position was zeroed by syncPositionsWithOnChain (market resolved without a SELL fill).
          // No sell proceeds were received for the remaining shares, so the remaining cost basis
          // is a realized loss. Using lastPrice (the last BUY fill price, not the resolution price)
          // would produce a near-zero P&L — incorrect. True P&L = $0 proceeds − remaining cost.
          agg.realizedPnl -= agg.openCost;
          agg.openShares = 0;
          agg.openCost = 0;
        }
      }
      continue;
    }

    aggregates.set(position.tokenId, {
      tokenId: position.tokenId,
      openShares: Math.max(0, position.size),
      openCost: Math.max(0, position.size) * position.avgPrice,
      totalBuyCost: Math.max(0, position.size) * position.avgPrice,
      totalBuyShares: Math.max(0, position.size),
      totalSellNotional: 0,
      realizedPnl: 0,
      tradedAmount: Math.max(0, position.size) * position.avgPrice,
      lastPrice: position.avgPrice,
      updatedAt: position.updatedAt
    });
  }

  const open: PositionSummaryRow[] = [];
  const closed: PositionSummaryRow[] = [];

  // Close any fill-computed aggregates that have no DB position row at all.
  // This handles a rare inconsistency where fills were recorded but the
  // corresponding Position row was never written (e.g. crash during upsert,
  // or fills from before position tracking was implemented). The DB Position
  // table is the authoritative source of open/closed status — if there is no
  // row, we treat the position as closed with a full loss of the cost basis.
  for (const agg of aggregates.values()) {
    if (agg.openShares > 0.001 && !tokenIdsWithDbPosition.has(agg.tokenId)) {
      agg.realizedPnl -= agg.openCost;
      agg.openShares = 0;
      agg.openCost = 0;
    }
  }

  const tokenIds = Array.from(aggregates.keys());
  const marketTitleByTokenId = new Map<string, string>();
  const latestEventTsByTokenId = new Map<string, number>();

  if (tokenIds.length > 0) {
    const leaderEvents = await prisma.leaderEvent.findMany({
      where: {
        profileId,
        tokenId: {
          in: tokenIds
        }
      },
      orderBy: { ts: "desc" },
      select: {
        ts: true,
        tokenId: true,
        rawJson: true
      }
    });

    for (const event of leaderEvents) {
      latestEventTsByTokenId.set(event.tokenId, new Date(event.ts).getTime());
      if (marketTitleByTokenId.has(event.tokenId)) {
        continue;
      }
      try {
        const parsed = JSON.parse(event.rawJson) as { title?: unknown };
        const title = typeof parsed.title === "string" ? parsed.title.trim() : "";
        if (title.length > 0) {
          marketTitleByTokenId.set(event.tokenId, title);
        }
      } catch {
        continue;
      }
    }
  }

  const nowMs = Date.now();
  const isLikelyResolved = (title: string, lastActivityMs: number): boolean => {
    const ageMs = nowMs - lastActivityMs;
    if (ageMs >= 6 * 60 * 60 * 1000) {
      return true;
    }
    if (/up or down/i.test(title) && ageMs >= 90 * 60 * 1000) {
      return true;
    }
    return false;
  };

  for (const item of aggregates.values()) {
    const isOpen = item.openShares > 0.001;
    // For open positions: current value = shares * live price.
    // For closed positions: current value = total sell proceeds received.
    const currentValue = isOpen
      ? item.openShares * item.lastPrice
      : item.totalSellNotional;
    const unrealizedPnl = isOpen ? currentValue - item.openCost : 0;

    // Open positions: show ONLY unrealized P&L on the current holding.
    // Including realizedPnl from prior sell cycles on the same token pollutes the
    // "is my position up or down?" question with historical trades that are already closed.
    // Closed positions: realizedPnl is the entire story (unrealizedPnl = 0).
    const pnl = isOpen ? unrealizedPnl : item.realizedPnl;

    // avgBuyPrice for open positions = cost per share of the currently held shares
    // (openCost / openShares). For closed positions = lifetime weighted avg buy price.
    const avgBuyPrice = isOpen
      ? item.openCost / item.openShares
      : (item.totalBuyShares > 0 ? item.totalBuyCost / item.totalBuyShares : 0);

    const marketTitle = marketTitleByTokenId.get(item.tokenId) ?? item.tokenId;
    const latestEventTsMs = latestEventTsByTokenId.get(item.tokenId) ?? new Date(item.updatedAt).getTime();
    const marketStatus: PositionSummaryRow["marketStatus"] =
      isOpen
        ? "OPEN"
        : isLikelyResolved(marketTitle, latestEventTsMs)
          ? "RESOLVED"
          : "SOLD_OUT";

    const row: PositionSummaryRow = {
      tokenId: item.tokenId,
      marketTitle,
      marketStatus,
      amount: isOpen ? item.openCost : item.totalBuyCost,
      // Open: current shares held. Closed: total shares ever purchased (openShares is 0 for closed).
      shares: isOpen ? item.openShares : item.totalBuyShares,
      avgBuyPrice,
      currentValue,
      pnl,
      lastPrice: item.lastPrice,
      updatedAt: item.updatedAt.toISOString()
    };

    if (isOpen) {
      open.push(row);
    } else {
      closed.push(row);
    }
  }

  open.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  closed.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

  return { open, closed };
}
