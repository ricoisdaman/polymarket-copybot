import {
  buildDefaultConfig,
  createDiscordNotifier,
  type LeaderEvent,
  type QuoteEstimate,
  type RiskDecision,
  type SkipReason,
  type TradeSide
} from "@copybot/core";
import {
  countStalePlacedIntents,
  DEFAULT_PROFILE_ID,
  ensureActiveConfigVersion,
  syncActiveConfigVersion,
  createAlert,
  createCopyIntent,
  createDbClient,
  createFill,
  createOrder,
  getRuntimeMetric,
  hasLeaderEvent,
  saveLeaderEvent,
  setRuntimeMetric,
  setRuntimeControlState,
  updateCopyIntentStatus,
  upsertPositionDelta
} from "@copybot/db";
import {
  createLeaderFeed,
  fetchLiveQuote,
  fetchMidPrices,
  fetchOnChainPositions,
  fetchTokenMarketStatuses,
  fetchTokenResolutionValues,
  placeOrder,
  pollOrderStatus,
  fetchUsdcBalance,
  validateClobCredentials,
  type ClobCredentials,
  type LiveQuoteEstimate
} from "@copybot/polymarket";

const profileId = process.env.PROFILE_ID ?? DEFAULT_PROFILE_ID;
const discord = createDiscordNotifier(
  process.env.DISCORD_WEBHOOK_URL,
  profileId,
  process.env.BOT_MODE ?? "PAPER"
);

type RuntimeState = {
  cashUSDC: number;
  positions: Map<string, number>;
  /** Maps tokenId → conditionId so we can enforce per-game (not per-token) caps. */
  conditionByToken: Map<string, string>;
  dailyNotionalUSDC: number;
  dailyKey: string;
};

const config = buildDefaultConfig();
const feed = createLeaderFeed({
  leaderWallet: config.leader.wallet,
  mode: config.leader.feedMode,
  pollIntervalSeconds: config.leader.pollIntervalSeconds,
  dataApiBaseUrl: process.env.POLYMARKET_DATA_API_URL,
  eventIntervalMs: 1500
});
const prisma = createDbClient();
const eventQueue: LeaderEvent[] = [];
let processing = false;
let haltedByDrawdown = false;
let lastComputedDrawdownUSDC = 0;
const alertCooldowns = new Map<string, number>();
// In LIVE mode this gets reset to the real wallet balance after hydration so the
// drawdown baseline reflects the actual starting capital for this session rather
// than the hardcoded default (which diverges after claims/deposits over time).
let startingUSDC = Number(process.env.STARTING_USDC ?? 50);
// Tracks the trading-day key used for the last drawdown baseline reset.
// Reset independently from state.dailyKey so the reconcile loop can update
// startingUSDC to current equity at each 6am UTC boundary regardless of
// whether processEvent has already flipped state.dailyKey.
let drawdownDayKey = "";
const runtimeControl = {
  killSwitch: config.safety.killSwitch,
  paused: config.safety.paused
};
const counters = {
  eventsSeen: 0,
  intentsPlaced: 0,
  intentsSkipped: 0,
  intentsRejected: 0,
  fills: 0
};
const startedAtMs = Date.now();

function getTradingDayStart(now = new Date()): Date {
  const resetHour = config.budget.dailyResetHourUtc;
  const start = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    resetHour,
    0,
    0,
    0
  ));
  if (now.getTime() < start.getTime()) {
    start.setUTCDate(start.getUTCDate() - 1);
  }
  return start;
}

function getTradingDayKey(now = new Date()): string {
  return getTradingDayStart(now).toISOString().slice(0, 10);
}

function getClobCredentials(): ClobCredentials | null {
  const address       = process.env.POLYMARKET_WALLET_ADDRESS;
  const proxyWallet   = process.env.POLYMARKET_PROXY_WALLET || undefined;
  const privateKey    = process.env.POLYMARKET_PRIVATE_KEY;
  const apiKey        = process.env.POLYMARKET_API_KEY;
  const apiSecret     = process.env.POLYMARKET_API_SECRET;
  const apiPassphrase = process.env.POLYMARKET_API_PASSPHRASE;
  if (!address || !privateKey || !apiKey || !apiSecret || !apiPassphrase) return null;
  return { address, proxyWallet, privateKey, apiKey, apiSecret, apiPassphrase };
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function fireAndForget(task: Promise<unknown>, label: string): void {
  task.catch((error) => {
    console.error("bot-worker async task failed", {
      label,
      error: error instanceof Error ? error.message : String(error)
    });
  });
}

const state: RuntimeState = {
  cashUSDC: startingUSDC,
  positions: new Map<string, number>(),
  conditionByToken: new Map<string, string>(),
  dailyNotionalUSDC: 0,
  dailyKey: getTradingDayKey()
};

async function hydratePaperRuntimeState(): Promise<void> {
  if (config.mode !== "PAPER") {
    return;
  }

  const [positions, fills, orders, intents] = await Promise.all([
    prisma.position.findMany({
      where: { profileId, size: { gt: 0 } },
      select: {
        tokenId: true,
        size: true
      }
    }),
    prisma.fill.findMany({
      where: { profileId },
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
        side: true
      }
    })
  ]);

  state.positions.clear();
  state.conditionByToken.clear();
  for (const position of positions) {
    state.positions.set(position.tokenId, Number(position.size.toFixed(6)));
  }

  const orderToIntent = new Map(orders.map((order) => [order.id, order.intentId]));
  const intentToSide = new Map(intents.map((intent) => [intent.id, intent.side]));
  const tradingDayStart = getTradingDayStart();
  const todayKey = getTradingDayKey();
  let netCashDelta = 0;
  let todayNotional = 0;

  for (const fill of fills) {
    const intentId = orderToIntent.get(fill.orderId);
    if (!intentId) {
      continue;
    }

    const side = intentToSide.get(intentId);
    if (!side) {
      continue;
    }

    const notional = fill.size * fill.price;
    if (side === "BUY") {
      netCashDelta -= notional;
    } else {
      netCashDelta += notional;
    }

    if (fill.ts >= tradingDayStart) {
      todayNotional += notional;
    }
  }

  state.cashUSDC = Number((startingUSDC + netCashDelta).toFixed(4));
  state.dailyKey = todayKey;
  state.dailyNotionalUSDC = Number(todayNotional.toFixed(4));

  await setRuntimeMetric(prisma, profileId, "bot.cash_usdc", String(state.cashUSDC));
  await setRuntimeMetric(prisma, profileId, "bot.daily_notional_usdc", String(state.dailyNotionalUSDC));

  console.log("bot-worker hydrated paper state", {
    startingUSDC,
    cashUSDC: state.cashUSDC,
    openMarkets: state.positions.size,
    dailyNotionalUSDC: state.dailyNotionalUSDC
  });
}

async function hydrateLiveRuntimeState(): Promise<void> {
  const clobUrl = process.env.POLYMARKET_CLOB_API_URL ?? "https://clob.polymarket.com";
  const creds = getClobCredentials();
  if (!creds) {
    throw new Error(
      "LIVE mode requires POLYMARKET_WALLET_ADDRESS, POLYMARKET_PRIVATE_KEY, " +
      "POLYMARKET_API_KEY, POLYMARKET_API_SECRET, and POLYMARKET_API_PASSPHRASE"
    );
  }

  // Validate private key before making any API calls — gives a clear error if
  // the user exported the wrong key or pasted mismatched credentials.
  const credError = validateClobCredentials(creds);
  if (credError) {
    throw new Error(credError);
  }

  // Determine whether this is the first-ever LIVE start or a worker restart.
  // Set live_mode_started_at early (before API calls) so the dashboard can
  // pivot on it even if subsequent API calls fail.
  const existingLiveStartMetric = await getRuntimeMetric(prisma, profileId, "bot.live_mode_started_at");
  const isFirstLiveStart = !existingLiveStartMetric;
  const liveStartTs = isFirstLiveStart ? Date.now() : Number(existingLiveStartMetric.value);
  if (isFirstLiveStart) {
    await setRuntimeMetric(prisma, profileId, "bot.live_mode_started_at", String(liveStartTs));
  }

  // Fetch real on-chain USDC balance.
  const balance = await fetchUsdcBalance(clobUrl, creds);

  // Persist starting balance for lifetime P&L calculation.
  // Write once — the first time this metric is missing — so restarts don't
  // reset the baseline. STARTING_USDC env var overrides the on-chain balance.
  const existingStartingBalanceMetric = await getRuntimeMetric(prisma, profileId, "bot.live_starting_usdc");
  if (!existingStartingBalanceMetric) {
    const startingBalance = process.env.STARTING_USDC
      ? Number(process.env.STARTING_USDC)
      : balance;
    await setRuntimeMetric(prisma, profileId, "bot.live_starting_usdc", String(startingBalance));
  }

  state.cashUSDC          = balance;
  state.positions.clear();
  state.dailyKey          = getTradingDayKey();
  state.dailyNotionalUSDC = 0;

  if (!isFirstLiveStart) {
    // Worker restart in LIVE mode — reload only positions and fills that
    // occurred after the original live-start timestamp (excludes paper data).
    const liveSince = new Date(liveStartTs);
    const [positions, fills, orders, intents] = await Promise.all([
      prisma.position.findMany({
        where: { profileId, size: { gt: 0 }, updatedAt: { gte: liveSince } },
        select: { tokenId: true, size: true }
      }),
      prisma.fill.findMany({
        where: { profileId, ts: { gte: liveSince } },
        orderBy: { ts: "asc" },
        select: { orderId: true, ts: true, price: true, size: true }
      }),
      prisma.order.findMany({
        where: { profileId, ts: { gte: liveSince } },
        select: { id: true, intentId: true }
      }),
      prisma.copyIntent.findMany({
        where: { profileId, ts: { gte: liveSince } },
        select: { id: true, side: true }
      })
    ]);

    for (const position of positions) {
      state.positions.set(position.tokenId, Number(position.size.toFixed(6)));
    }

    const orderToIntent = new Map(orders.map((o) => [o.id, o.intentId]));
    const intentToSide  = new Map(intents.map((i) => [i.id, i.side]));
    const tradingDayStart = getTradingDayStart();
    let todayNotional = 0;
    for (const fill of fills) {
      if (fill.ts < tradingDayStart) continue;
      const intentId = orderToIntent.get(fill.orderId);
      if (!intentId) continue;
      const side = intentToSide.get(intentId);
      if (!side) continue;
      todayNotional += fill.size * fill.price;
    }
    state.dailyNotionalUSDC = Number(todayNotional.toFixed(4));
  }
  // else: first LIVE start — position map is empty and daily notional is 0.

  await setRuntimeMetric(prisma, profileId, "bot.cash_usdc",           String(state.cashUSDC));
  await setRuntimeMetric(prisma, profileId, "bot.daily_notional_usdc", String(state.dailyNotionalUSDC));

  console.log("bot-worker hydrated live state", {
    cashUSDC:          state.cashUSDC,
    openMarkets:       state.positions.size,
    dailyNotionalUSDC: state.dailyNotionalUSDC,
    isFirstLiveStart
  });

  // Immediately reconcile positions against on-chain state so any markets that
  // resolved while the bot was offline are zeroed out before trading resumes.
  try {
    await syncPositionsWithOnChain(creds);
  } catch (err) {
    console.warn("syncPositionsWithOnChain at startup failed (non-fatal):", err instanceof Error ? err.message : String(err));
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function resetDailyIfNeeded(): boolean {
  const today = getTradingDayKey();
  if (today !== state.dailyKey) {
    state.dailyKey = today;
    state.dailyNotionalUSDC = 0;
    return true;
  }
  return false;
}

function evaluateRisk(event: LeaderEvent, quote: QuoteEstimate): RiskDecision {
  if (runtimeControl.killSwitch) {
    return { allowed: false, reason: "KILL_SWITCH" };
  }

  if (haltedByDrawdown) {
    return { allowed: false, reason: "DRAWDOWN_STOP" };
  }

  if (runtimeControl.paused) {
    return { allowed: false, reason: "PAUSED" };
  }

  if (Date.now() - event.ts > config.execution.maxEventAgeMs) {
    return { allowed: false, reason: "EVENT_TOO_OLD" };
  }

  if ((event.side === "BUY" && !config.leader.copyBuys) || (event.side === "SELL" && !config.leader.copySells)) {
    return { allowed: false, reason: "COPY_SIDE_DISABLED" };
  }

  if (event.price < config.filters.minPrice || event.price > config.filters.maxPrice) {
    return { allowed: false, reason: "PRICE_FILTER" };
  }
  // Also block if the live CLOB quote has slipped beyond the ceiling since the leader's fill.
  // This is the key guard: event.price might be 0.79 (passes filter) but the orderbook
  // is now showing 0.81, meaning we'd pay above the max. Enforce on BUY only — for SELLs,
  // slippage goes the other direction and the min-price filter already handles it.
  if (event.side === "BUY" && quote.executablePrice > config.filters.maxPrice) {
    return { allowed: false, reason: "PRICE_FILTER" };
  }

  if (config.filters.blockedTitleKeywords.length > 0 && event.side === "BUY") {
    const title = String(event.raw?.title ?? event.raw?.question ?? "").toLowerCase();
    if (title && config.filters.blockedTitleKeywords.some((kw) => title.includes(kw))) {
      return { allowed: false, reason: "TITLE_BLOCKED" };
    }
  }

  const fixedNotional = clamp(
    config.budget.perTradeNotionalUSDC,
    config.budget.minTradeNotionalUSDC,
    config.budget.maxTradeNotionalUSDC
  );

  const desiredSize = Number((fixedNotional / Math.max(quote.executablePrice, 0.0001)).toFixed(6));
  const desiredNotional = Number((desiredSize * quote.executablePrice).toFixed(4));

  if (event.side === "SELL") {
    const currentPosition = state.positions.get(event.tokenId) ?? 0;
    if (currentPosition <= 0) {
      return { allowed: false, reason: "NO_POSITION_TO_SELL" };
    }

    // If sellFullPositionOnLeaderSell is enabled, close the entire holding when the
    // leader sells — regardless of their sell size relative to ours. This mirrors
    // the leader's "exit this market" signal more faithfully than a fixed-notional slice.
    const reducedSize = config.leader.sellFullPositionOnLeaderSell
      ? currentPosition
      : Math.min(currentPosition, desiredSize);
    const reducedNotional = Number((reducedSize * quote.executablePrice).toFixed(4));
    if (reducedNotional < config.execution.minOrderNotionalUSDC) {
      return { allowed: false, reason: "MIN_ORDER_NOTIONAL" };
    }
    if (reducedSize < config.execution.minOrderShares) {
      return { allowed: false, reason: "MIN_ORDER_SHARES" };
    }
    return {
      allowed: true,
      desiredNotional: reducedNotional,
      desiredSize: reducedSize
    };
  }

  // Round up to comply with venue minimums if needed, but cap at maxTradeNotionalUSDC
  let finalSize = desiredSize;
  let finalNotional = desiredNotional;

  if (finalSize < config.execution.minOrderShares || finalNotional < config.execution.minOrderNotionalUSDC) {
    const sizeForMinShares = config.execution.minOrderShares;
    const sizeForMinNotional = config.execution.minOrderNotionalUSDC / Math.max(quote.executablePrice, 0.0001);
    finalSize = Number(Math.max(sizeForMinShares, sizeForMinNotional).toFixed(6));
    finalNotional = Number((finalSize * quote.executablePrice).toFixed(4));
    // Cannot round up without exceeding the per-trade cap — skip instead
    if (finalNotional > config.budget.maxTradeNotionalUSDC) {
      return { allowed: false, reason: "MIN_ORDER_SHARES" };
    }
  }

  const availableToTrade = state.cashUSDC - config.budget.reserveUSDC - config.budget.safetyBufferUSDC;
  if (availableToTrade < finalNotional) {
    return { allowed: false, reason: "INSUFFICIENT_AVAILABLE_AFTER_RESERVE" };
  }

  // In PAPER mode, estimateExecutableQuote() uses pseudoRandom() — not real market data.
  // Applying spread/slippage/liquidity filters against fake numbers would block real leader
  // trades arbitrarily. Skip these checks in PAPER mode; they matter only in LIVE execution.
  if (config.mode !== "PAPER") {
    if (quote.spreadBps > config.execution.maxSpreadBps) {
      return { allowed: false, reason: "SPREAD_TOO_WIDE" };
    }

    if (quote.slippageBps > config.execution.maxSlippageBps) {
      return { allowed: false, reason: "SLIPPAGE_TOO_HIGH" };
    }

    // Check we can actually fill the order: require at least 95% fill from book-walk.
    // This is more reliable than a depth-multiple heuristic — it directly answers
    // "can this book fill our order right now?" and avoids false positives when
    // a level has barely enough depth (e.g. 5 shares available, we need 2, but
    // depth-multiple would reject because 5 < 2*3=6).
    if (quote.filledSize < finalSize * 0.95) {
      return { allowed: false, reason: "INSUFFICIENT_LIQUIDITY" };
    }
  }

  // Cap is per conditionId (whole game), not per tokenId (single outcome).
  // This blocks copying the leader's hedge leg on the same game we already have a position in.
  const conditionId = event.conditionId;
  const alreadyInCondition = Array.from(state.conditionByToken.entries())
    .some(([tok, cid]) => cid === conditionId && (state.positions.get(tok) ?? 0) > 0);
  if (alreadyInCondition) {
    return { allowed: false, reason: "MAX_NOTIONAL_PER_MARKET" };
  }
  const currentTokenNotional = (state.positions.get(event.tokenId) ?? 0) * quote.executablePrice;
  if (currentTokenNotional + finalNotional > config.budget.maxNotionalPerMarketUSDC) {
    return { allowed: false, reason: "MAX_NOTIONAL_PER_MARKET" };
  }

  const openMarkets = Array.from(state.positions.values()).filter((size) => size > 0).length;
  if (openMarkets >= config.budget.maxOpenMarkets && (state.positions.get(event.tokenId) ?? 0) <= 0) {
    return { allowed: false, reason: "MAX_OPEN_MARKETS" };
  }

  if (state.dailyNotionalUSDC + finalNotional > config.budget.maxDailyNotionalUSDC) {
    return { allowed: false, reason: "MAX_DAILY_NOTIONAL" };
  }

  return { allowed: true, desiredNotional: finalNotional, desiredSize: finalSize };
}

async function applyPaperFill(side: TradeSide, tokenId: string, fillSize: number, fillPrice: number, conditionId?: string): Promise<void> {
  const notional = fillSize * fillPrice;
  const currentPosition = state.positions.get(tokenId) ?? 0;
  if (side === "BUY") {
    state.cashUSDC = Number((state.cashUSDC - notional).toFixed(4));
    state.positions.set(tokenId, Number((currentPosition + fillSize).toFixed(6)));
    if (conditionId) state.conditionByToken.set(tokenId, conditionId);
  } else {
    state.cashUSDC = Number((state.cashUSDC + notional).toFixed(4));
    const next = Math.max(0, currentPosition - fillSize);
    state.positions.set(tokenId, Number(next.toFixed(6)));
    if (next === 0) state.conditionByToken.delete(tokenId);
  }
  state.dailyNotionalUSDC = Number((state.dailyNotionalUSDC + notional).toFixed(4));
  await setRuntimeMetric(prisma, profileId, "bot.cash_usdc", String(state.cashUSDC));
  await setRuntimeMetric(prisma, profileId, "bot.daily_notional_usdc", String(state.dailyNotionalUSDC));
}

async function persistSkip(leaderEventId: string, event: LeaderEvent, reason: SkipReason): Promise<void> {
  await createCopyIntent(prisma, profileId, {
    leaderEventId,
    tokenId: event.tokenId,
    side: event.side,
    leaderSize: event.size,
    desiredNotional: 0,
    desiredSize: 0,
    status: "SKIPPED",
    reason,
    mode: config.mode
  });
  counters.intentsSkipped += 1;
}

async function processEvent(event: LeaderEvent): Promise<void> {
  counters.eventsSeen += 1;
  if (resetDailyIfNeeded()) {
    await setRuntimeMetric(prisma, profileId, "bot.daily_notional_usdc", String(state.dailyNotionalUSDC));
    if (haltedByDrawdown) {
      haltedByDrawdown = false;
      runtimeControl.paused = false;
      await setRuntimeControlState(
        prisma,
        profileId,
        { paused: false },
        "bot-worker",
        "Auto-resume: new trading day drawdown reset",
        config
      );
      discord.send(`✅ New trading day — drawdown halt auto-cleared, trading resumed.`);
    }
  }

  let quote: QuoteEstimate;
  let negRisk = true;

  if (config.mode === "LIVE") {
    const clobUrl = process.env.POLYMARKET_CLOB_API_URL ?? "https://clob.polymarket.com";
    try {
      // Walk the book for the larger of: leader's size or our own expected order size.
      // If perTradeNotional / price > event.size we need more depth than the leader used,
      // and fetching only event.size would falsely trigger INSUFFICIENT_LIQUIDITY.
      const expectedBotSize = config.budget.perTradeNotionalUSDC / Math.max(event.price, 0.0001);
      const quoteSize = Math.max(event.size, expectedBotSize);
      const lq = await fetchLiveQuote(clobUrl, event.conditionId, event.tokenId, event.side, quoteSize);
      quote = lq;
      negRisk = lq.negRisk;
    } catch (err) {
      if (shouldEmitAlert("LIVE_QUOTE_FAILED", 10_000)) {
        await createAlert(prisma, profileId, "WARN", "LIVE_QUOTE_FAILED",
          "Failed to fetch live orderbook quote", {
            tokenId: event.tokenId,
            error: err instanceof Error ? err.message : String(err)
          });
      }
      return;
    }
  } else {
    // For paper mode, fetch real CLOB prices so P&L reflects actual market conditions.
    // This is what makes paper results a reliable predictor of live profitability.
    const clobUrl = process.env.POLYMARKET_CLOB_API_URL ?? "https://clob.polymarket.com";
    try {
      const expectedBotSize = config.budget.perTradeNotionalUSDC / Math.max(event.price, 0.0001);
      const quoteSize = Math.max(event.size, expectedBotSize);
      const lq = await fetchLiveQuote(clobUrl, event.conditionId, event.tokenId, event.side, quoteSize);
      quote = lq;
    } catch {
      // CLOB unreachable — use leader's real execution price as the best available proxy.
      // Far more accurate than pseudoRandom() for P&L testing.
      const p = event.price;
      quote = {
        tokenId: event.tokenId,
        side: event.side,
        bestBid: Number((p - 0.001).toFixed(4)),
        bestAsk: Number((p + 0.001).toFixed(4)),
        executablePrice: p,
        spreadBps: 20,
        slippageBps: 5,
        topOfBookDepth: 100,
        filledSize: event.size,
      };
    }
  }

  const seen = await hasLeaderEvent(prisma, profileId, event.dedupeKey);
  if (seen) {
    await createAlert(prisma, profileId, "INFO", "DUPLICATE_EVENT", "Dropped duplicate leader event", {
      dedupeKey: event.dedupeKey
    });
    return;
  }

  const leaderEventId = await saveLeaderEvent(prisma, profileId, event);
  const decision = evaluateRisk(event, quote);

  if (!decision.allowed) {
    await persistSkip(leaderEventId, event, decision.reason);
    return;
  }

  const intentId = await createCopyIntent(prisma, profileId, {
    leaderEventId,
    tokenId: event.tokenId,
    side: event.side,
    leaderSize: event.size,
    desiredNotional: decision.desiredNotional,
    desiredSize: decision.desiredSize,
    status: "PLACED",
    mode: config.mode
  });
  counters.intentsPlaced += 1;

  const execution = await executeIntent(event, decision.desiredSize, quote.executablePrice, intentId, negRisk);
  if (!execution.executed) {
    await updateCopyIntentStatus(prisma, intentId, "REJECTED", execution.reason);
    counters.intentsRejected += 1;
    return;
  }

  counters.fills += 1;
  await applyPaperFill(event.side, event.tokenId, execution.fillSize, execution.fillPrice, event.conditionId);
  await upsertPositionDelta(prisma, profileId, event.tokenId, event.side, execution.fillSize, execution.fillPrice);
  await updateCopyIntentStatus(prisma, intentId, execution.status);

  // Discord fill notification
  const marketLabel = (event.raw?.title as string | undefined)?.slice(0, 60) ?? event.tokenId.slice(0, 16);
  const notional = (execution.fillSize * execution.fillPrice).toFixed(2);
  if (event.side === "BUY") {
    discord.send(`📈 **BUY** — ${marketLabel}\n> ${execution.fillSize.toFixed(4)} shares @ \$${execution.fillPrice.toFixed(3)} | notional: \$${notional} | cash: \$${state.cashUSDC}`);
  } else {
    discord.send(`📉 **SELL** — ${marketLabel}\n> ${execution.fillSize.toFixed(4)} shares @ \$${execution.fillPrice.toFixed(3)} | notional: \$${notional} | cash: \$${state.cashUSDC}`);
  }
}

async function executeIntent(
  event: LeaderEvent,
  desiredSize: number,
  price: number,
  intentId: string,
  negRisk = true
): Promise<
  | { executed: true; fillSize: number; fillPrice: number; status: "FILLED" | "PARTIALLY_FILLED_OK" }
  | { executed: false; reason: string }
> {
  if (config.mode === "PAPER") {
    const strictPaper = config.execution.strictVenueConstraintsInPaper;
    const fillRatio = strictPaper ? 1 : (config.execution.acceptPartialFillAndStop ? 0.5 + Math.random() * 0.5 : 1);
    const fillSize = Number((desiredSize * fillRatio).toFixed(6));
    const fillNotional = fillSize * price;
    if (strictPaper && fillSize < config.execution.minOrderShares) {
      return { executed: false, reason: "PAPER_MIN_ORDER_SHARES" };
    }
    if (strictPaper && fillNotional < config.execution.minOrderNotionalUSDC) {
      return { executed: false, reason: "PAPER_MIN_ORDER_NOTIONAL" };
    }
    const status = fillRatio < 0.999 ? "PARTIALLY_FILLED_OK" : "FILLED";

    const orderId = await createOrder(prisma, profileId, {
      intentId,
      side: event.side,
      price,
      size: desiredSize,
      status
    });

    await createFill(prisma, profileId, {
      orderId,
      price,
      size: fillSize,
      fee: 0,
      liquiditySide: "TAKER"
    });

    return { executed: true, fillSize, fillPrice: price, status };
  }

  // ── LIVE execution ────────────────────────────────────────────────────────
  if (process.env.ENABLE_LIVE_EXECUTION !== "true") {
    await createAlert(prisma, profileId, "WARN", "LIVE_EXECUTION_DISABLED",
      "LIVE mode blocked because ENABLE_LIVE_EXECUTION is not true", { mode: config.mode });
    return { executed: false, reason: "LIVE_EXECUTION_DISABLED" };
  }

  const clobUrl = process.env.POLYMARKET_CLOB_API_URL ?? "https://clob.polymarket.com";
  const creds = getClobCredentials();
  if (!creds) {
    await createAlert(prisma, profileId, "ERROR", "LIVE_MISSING_CREDENTIALS",
      "Missing required live execution credentials (POLYMARKET_WALLET_ADDRESS / PRIVATE_KEY / API_SECRET / API_PASSPHRASE)", {});
    return { executed: false, reason: "LIVE_MISSING_CREDENTIALS" };
  }

  try {
    const { orderId: clobOrderId, initialStatus } = await placeOrder(
      clobUrl, creds,
      event.tokenId, event.conditionId,
      event.side, desiredSize, price, negRisk
    );

    let sizeMatched = desiredSize;
    let fillPrice   = price;

    if (initialStatus === "matched") {
      // FOK fully matched immediately — response contains full fill
    } else if (initialStatus === "delayed") {
      // Polymarket queued it — poll until terminal state or maxChaseSeconds
      const poll = await pollOrderStatus(
        clobUrl, creds, clobOrderId, config.execution.maxChaseSeconds * 1000
      );
      if (!poll.matched) {
        return { executed: false, reason: "LIVE_ORDER_NOT_FILLED" };
      }
      if (poll.sizeMatched > 0) sizeMatched = poll.sizeMatched;
      if (poll.fillPrice  > 0) fillPrice   = poll.fillPrice;
    } else {
      // "unmatched": stale quote missed the market — re-fetch the current ask so the
      // retry bids at the actual live price rather than a price that already moved away.
      const slipFactor = config.execution.maxSlippageBps / 10000;
      let retryPrice: number;
      try {
        const freshQ = await fetchLiveQuote(clobUrl, event.conditionId, event.tokenId, event.side, desiredSize);
        retryPrice = event.side === "BUY"
          ? Math.min(0.9999, Number((freshQ.executablePrice * (1 + slipFactor)).toFixed(4)))
          : Math.max(0.0001, Number((freshQ.executablePrice * (1 - slipFactor)).toFixed(4)));
      } catch {
        // Fresh quote failed — fall back to slippage on the original stale price
        retryPrice = event.side === "BUY"
          ? Math.min(0.9999, Number((price * (1 + slipFactor)).toFixed(4)))
          : Math.max(0.0001, Number((price * (1 - slipFactor)).toFixed(4)));
      }
      try {
        const { orderId: retryOrderId, initialStatus: retryStatus } = await placeOrder(
          clobUrl, creds, event.tokenId, event.conditionId, event.side, desiredSize, retryPrice, negRisk
        );
        if (retryStatus === "matched") {
          fillPrice = retryPrice;
        } else if (retryStatus === "delayed") {
          const retryPoll = await pollOrderStatus(
            clobUrl, creds, retryOrderId, config.execution.maxChaseSeconds * 1000
          );
          if (!retryPoll.matched) return { executed: false, reason: "LIVE_ORDER_NOT_FILLED" };
          if (retryPoll.sizeMatched > 0) sizeMatched = retryPoll.sizeMatched;
          fillPrice = retryPoll.fillPrice > 0 ? retryPoll.fillPrice : retryPrice;
        } else {
          return { executed: false, reason: "LIVE_ORDER_NOT_FILLED" };
        }
      } catch {
        return { executed: false, reason: "LIVE_ORDER_NOT_FILLED" };
      }
    }

    const dbOrderId = await createOrder(prisma, profileId, {
      intentId,
      side:   event.side,
      price:  fillPrice,
      size:   sizeMatched,
      status: "FILLED"
    });

    await createFill(prisma, profileId, {
      orderId:       dbOrderId,
      price:         fillPrice,
      size:          sizeMatched,
      fee:           0,
      liquiditySide: "TAKER"
    });

    return { executed: true, fillSize: sizeMatched, fillPrice, status: "FILLED" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // 403 geo-restriction is a transient infrastructure issue, not a bot bug.
    // Log it as WARN so it doesn't count toward the error storm threshold.
    if (message.includes("403") || message.toLowerCase().includes("restricted in your region")) {
      await createAlert(prisma, profileId, "WARN", "GEO_RESTRICTED",
        "Order rejected: trading restricted in this region (VPN needed)", { error: message, tokenId: event.tokenId });
      return { executed: false, reason: "GEO_RESTRICTED" };
    }
    // Insufficient wallet balance — transient, not a code bug. Log as WARN only.
    if (message.toLowerCase().includes("not enough balance") || message.toLowerCase().includes("allowance")) {
      await createAlert(prisma, profileId, "WARN", "INSUFFICIENT_BALANCE",
        "Order rejected: insufficient USDC balance in wallet", { error: message, tokenId: event.tokenId });
      return { executed: false, reason: "INSUFFICIENT_BALANCE" };
    }
    await createAlert(prisma, profileId, "ERROR", "LIVE_EXECUTION_ERROR",
      "Live order placement failed", { error: message, tokenId: event.tokenId });
    return { executed: false, reason: "LIVE_EXECUTION_ERROR" };
  }
}

function shouldEmitAlert(code: string, cooldownMs: number): boolean {
  const now = Date.now();
  const last = alertCooldowns.get(code) ?? 0;
  if (now - last < cooldownMs) {
    return false;
  }
  alertCooldowns.set(code, now);
  return true;
}

/**
 * Reconcile local DB positions against the Gamma API on-chain state.
 * Any position we think is open but is no longer on-chain (market resolved,
 * position sold out-of-band, etc.) gets zeroed in both memory and the DB.
 * Called at LIVE startup and every reconcile cycle to prevent stale "open"
 * positions from blocking the MAX_OPEN_MARKETS guard.
 */
async function syncPositionsWithOnChain(liveCreds: ClobCredentials): Promise<void> {
  const walletAddress = liveCreds.proxyWallet ?? liveCreds.address;
  const dataApiUrl = process.env.POLYMARKET_DATA_API_URL ?? "https://data-api.polymarket.com";
  const onChainPositions = await fetchOnChainPositions(walletAddress, dataApiUrl);

  // Grace period: the Polymarket data API can take several minutes to reflect a
  // newly filled order. Skip zeroing any position updated in the last 10 minutes
  // to prevent a freshly-bought position from being prematurely zeroed, which
  // would make equity appear to collapse and trigger a false drawdown stop.
  const graceCutoff = new Date(Date.now() - 10 * 60 * 1000);

  // Find all local DB positions that have size > 0, are older than the grace
  // period, and have no matching on-chain entry.
  const dbOpenPositions = await prisma.position.findMany({
    where: { profileId, size: { gt: 0 }, updatedAt: { lt: graceCutoff } },
    select: { tokenId: true, size: true, avgPrice: true }
  });

  const toZero = dbOpenPositions
    .filter(p => !onChainPositions.has(p.tokenId))
    .map(p => p.tokenId);

  if (toZero.length > 0) {
    await prisma.position.updateMany({
      where: { profileId, tokenId: { in: toZero } },
      data: { size: 0, updatedAt: new Date() }
    });
    for (const tokenId of toZero) {
      state.positions.set(tokenId, 0);
      state.conditionByToken.delete(tokenId);
    }
    console.log(`syncPositionsWithOnChain: zeroed ${toZero.length} resolved/closed positions`);
    await createAlert(prisma, profileId, "INFO", "POSITIONS_SYNCED",
      `Zeroed ${toZero.length} positions no longer present on-chain (market resolved or sold)`,
      { count: toZero.length, sample: toZero.slice(0, 5) }
    );

    // Fire a Discord alert for any position that resolved at $0 (full loss).
    // Check Gamma API resolution value for each zeroed token; value=0 means the
    // outcome lost (e.g. team didn't win). Fires per-position so each loss is visible.
    try {
      const resValues = await fetchTokenResolutionValues(toZero);
      for (const tokenId of toZero) {
        const resValue = resValues.get(tokenId);
        if (resValue !== undefined && resValue <= 0.01) {
          const pos = dbOpenPositions.find(p => p.tokenId === tokenId);
          const costBasis = pos ? Number((pos.size * pos.avgPrice).toFixed(2)) : 0;
          if (costBasis >= 0.01) {
            discord.send(`🔴 **ZERO RESOLUTION** — position resolved at $0.00\n> token: \`${tokenId.slice(0, 16)}\` | cost basis: \$${costBasis} | full loss`);
          }
        }
      }
    } catch {
      // Gamma API unavailable — skip resolution check, no alert lost
    }
  }
}

async function runReconcileChecks(): Promise<void> {
  const stalePlaced = await countStalePlacedIntents(prisma, profileId, config.safety.confirmBackfillSeconds);
  if (stalePlaced > 0 && shouldEmitAlert("CONFIRM_BACKFILL_TIMEOUT", 30_000)) {
    await createAlert(prisma, profileId, "WARN", "CONFIRM_BACKFILL_TIMEOUT", "Placed intents are stale past confirm window", {
      stalePlaced,
      confirmBackfillSeconds: config.safety.confirmBackfillSeconds
    });
  }

  // ── Refresh cash balance BEFORE computing drawdown ───────────────────────
  // Fetch the latest wallet balance first so the drawdown check uses real cash.
  // Position sync (syncPositionsWithOnChain) is intentionally done AFTER the
  // drawdown check — see the comment below.
  if (config.mode === "LIVE") {
    const liveCreds = getClobCredentials();
    if (liveCreds) {
      try {
        const clobUrl = process.env.POLYMARKET_CLOB_API_URL ?? "https://clob.polymarket.com";
        const realBalance = await fetchUsdcBalance(clobUrl, liveCreds);
        state.cashUSDC = realBalance;
        await setRuntimeMetric(prisma, profileId, "bot.cash_usdc", String(realBalance));
      } catch {
        // Network blip — keep in-memory estimate; will retry next reconcile cycle
      }
    }
  }

  // Drawdown = losses only. Use cost basis of open positions so deployed capital
  // isn't counted as a loss. totalEquity = cash + sum(position.size * avgPrice).
  // This only drops below startingUSDC when positions are closed at a loss.
  //
  // IMPORTANT: we read DB positions BEFORE calling syncPositionsWithOnChain so
  // that the drawdown check sees the cost basis of positions we currently hold.
  // syncPositionsWithOnChain zeros positions that the data API no longer shows,
  // but there is a ~2–5 min lag between a market resolving and the USDC claim
  // appearing in the wallet. If we zeroed positions and then immediately checked
  // drawdown in the same cycle, equity would appear to collapse (cost basis 0,
  // cash still low before claim arrives) and fire a false drawdown stop.
  // Running sync AFTER the drawdown check means zeroed positions only affect
  // the drawdown calculation from the NEXT reconcile cycle (30s later), by
  // which time the wallet balance will have been updated by the arriving claim.

  const openPositions = await prisma.position.findMany({ where: { profileId, size: { gt: 0 } } });
  const costBasis = openPositions.reduce((sum, p) => sum + p.size * p.avgPrice, 0);
  const totalEquity = state.cashUSDC + Number(costBasis.toFixed(4));

  // Reset the drawdown baseline at each new trading day so MAX_DAILY_DRAWDOWN_USDC
  // applies as a true per-day limit rather than accumulating across bot sessions.
  // This check runs in the reconcile loop (where totalEquity is freshly computed)
  // using a separate day key so it fires exactly once per day regardless of
  // whether processEvent has already advanced state.dailyKey.
  const reconcileTodayKey = getTradingDayKey();
  if (reconcileTodayKey !== drawdownDayKey) {
    drawdownDayKey = reconcileTodayKey;
    if (!process.env.STARTING_USDC) {
      startingUSDC = totalEquity;
      await setRuntimeMetric(prisma, profileId, "bot.drawdown_baseline_usdc", String(startingUSDC));
    }
    // Clear any carry-over drawdown halt from the previous day.
    if (haltedByDrawdown) {
      haltedByDrawdown = false;
      runtimeControl.paused = false;
      await setRuntimeControlState(
        prisma,
        profileId,
        { paused: false },
        "bot-worker",
        "Auto-resume: new trading day drawdown reset",
        config
      );
      discord.send(`✅ New trading day — drawdown baseline reset to \$${startingUSDC.toFixed(2)}, trading resumed.`);
    } else {
      discord.send(`📅 New trading day — drawdown baseline reset to \$${startingUSDC.toFixed(2)}.`);
    }
  }

  const drawdownUSDC = Number((startingUSDC - totalEquity).toFixed(4));
  lastComputedDrawdownUSDC = drawdownUSDC;
  if (drawdownUSDC >= config.budget.maxDailyDrawdownUSDC && !haltedByDrawdown) {
    haltedByDrawdown = true;
    runtimeControl.paused = true;
    await setRuntimeControlState(
      prisma,
      profileId,
      { paused: true },
      "bot-worker",
      "Daily drawdown stop reached",
      config
    );
    await createAlert(prisma, profileId, "ERROR", "DAILY_DRAWDOWN_STOP", "Daily drawdown stop reached, pausing new intents", {
      drawdownUSDC,
      maxDailyDrawdownUSDC: config.budget.maxDailyDrawdownUSDC
    });
    discord.send(`⚠️ **Drawdown stop** — daily loss \$${drawdownUSDC.toFixed(2)} ≥ limit \$${config.budget.maxDailyDrawdownUSDC}. Trades paused.`);
  }

  await setRuntimeMetric(prisma, profileId, "bot.last_reconcile_ts", String(Date.now()));

  // ── Take-profit auto-exit ────────────────────────────────────────────────
  // If takeProfitBps > 0, scan open positions and queue a synthetic SELL event
  // for any position whose current mark price has risen >= takeProfitBps since
  // our average buy cost. This lets us lock in gains without waiting for the
  // leader to sell — particularly useful for resolved/expiring markets.
  if (config.execution.takeProfitBps > 0 && config.mode === "LIVE") {
    const clobUrl = process.env.POLYMARKET_CLOB_API_URL ?? "https://clob.polymarket.com";
    const tpPositions = await prisma.position.findMany({
      where: { profileId, size: { gt: 0 } },
      select: { tokenId: true, size: true, avgPrice: true }
    });
    for (const pos of tpPositions) {
      if (pos.avgPrice <= 0) continue;
      try {
        // Fetch current mid price from CLOB for this token's synthetic condition.
        // We use a minimal quote to get the current best bid (sell side).
        const liveQ = await fetchLiveQuote(clobUrl, "0x0", pos.tokenId, "SELL", pos.size);
        const gainBps = Math.round((liveQ.executablePrice - pos.avgPrice) / pos.avgPrice * 10000);
        if (gainBps >= config.execution.takeProfitBps) {
          const tpEvent: LeaderEvent = {
            eventId: `tp-${pos.tokenId}-${Date.now()}`,
            dedupeKey: `tp-${pos.tokenId}-${Math.floor(Date.now() / 60000)}`, // dedupe within same minute
            ts: Date.now(),
            leaderWallet: "take-profit",
            conditionId: "0x0",
            tokenId: pos.tokenId,
            side: "SELL",
            price: liveQ.executablePrice,
            size: pos.size,
            usdcSize: pos.size * liveQ.executablePrice,
            source: "PUBLIC_WS",
            raw: { trigger: "TAKE_PROFIT", gainBps }
          };
          eventQueue.push(tpEvent);
          if (shouldEmitAlert("TAKE_PROFIT_QUEUED", 5_000)) {
            await createAlert(prisma, profileId, "INFO", "TAKE_PROFIT_QUEUED",
              `Take-profit triggered: +${gainBps}bps on ${pos.tokenId.slice(0, 16)}`,
              { tokenId: pos.tokenId, gainBps, avgCost: pos.avgPrice, markPrice: liveQ.executablePrice });
          }
        }
      } catch {
        // Quote fetch failed for this token — skip, retry next reconcile cycle
      }
    }
  }

  // ── Sync positions with on-chain state AFTER the drawdown check ─────────────
  // Doing this after (not before) the drawdown check avoids the same-cycle race
  // where newly-zeroed positions make equity appear to collapse before the USDC
  // claim arrives in the wallet. The effect of any resolved positions will be
  // captured accurately in the NEXT reconcile cycle once the wallet balance
  // reflects the incoming claim.
  if (config.mode === "LIVE") {
    const liveCreds = getClobCredentials();
    if (liveCreds) {
      try {
        await syncPositionsWithOnChain(liveCreds);
      } catch {
        // Network blip — retry next reconcile cycle
      }
    }
  }

  // ── Paper position sync ──────────────────────────────────────────────────
  // In PAPER mode there is no on-chain wallet to reconcile against, so we use
  // the leader's data-api positions as a proxy. When the leader no longer holds
  // a token (because they sold it or the market resolved), we zero the paper
  // position and credit back any resolution proceeds.
  if (config.mode === "PAPER") {
    try {
      await syncPaperPositions();
    } catch {
      // Network blip — retry next reconcile cycle
    }
  }
}

/**
 * Paper-mode equivalent of syncPositionsWithOnChain.
 * Uses the leader's data-api positions as the source of truth: any token
 * we hold (on paper) that the leader no longer holds has either been sold
 * or resolved. We zero the position and credit any YES-resolution proceeds
 * back to state.cashUSDC so capital becomes available for new trades.
 */
async function syncPaperPositions(): Promise<void> {
  const dataApiUrl = process.env.POLYMARKET_DATA_API_URL ?? "https://data-api.polymarket.com";
  const clobUrl = process.env.POLYMARKET_CLOB_API_URL ?? "https://clob.polymarket.com";

  let leaderPositions: Map<string, number>;
  try {
    leaderPositions = await fetchOnChainPositions(config.leader.wallet, dataApiUrl);
  } catch {
    // Data API unreachable — keep positions as-is, retry next cycle
    return;
  }

  // Same 10-min grace period as syncPositionsWithOnChain — prevents a freshly
  // copied BUY from being immediately zeroed before the data API reflects it.
  const graceCutoff = new Date(Date.now() - 10 * 60 * 1000);
  const dbOpenPositions = await prisma.position.findMany({
    where: { profileId, size: { gt: 0 }, updatedAt: { lt: graceCutoff } },
    select: { tokenId: true, size: true, avgPrice: true }
  });

  const toZero = dbOpenPositions.filter(p => !leaderPositions.has(p.tokenId));

  // Second pass: positions the leader still holds, but Gamma shows the market
  // is "proposed" or "resolved" (UMA oracle accepted a settlement, challenge
  // window may still be open). Close at current CLOB mid — the price is
  // effectively final at this point (0.9995 for a YES-resolved market).
  const leaderHeld = dbOpenPositions.filter(p => leaderPositions.has(p.tokenId));
  if (leaderHeld.length > 0) {
    const gammaStatuses = await fetchTokenMarketStatuses(leaderHeld.map(p => p.tokenId));
    for (const pos of leaderHeld) {
      const status = gammaStatuses.get(pos.tokenId);
      if (!status) continue;
      const isSettling =
        status.umaResolutionStatus === "proposed" ||
        status.umaResolutionStatus === "resolved" ||
        status.closed;
      if (isSettling) {
        toZero.push(pos);
      }
    }
  }

  if (toZero.length === 0) return;

  // Fetch CLOB midpoint for each position to zero.
  // - If CLOB has a price → leader exited but market still active; simulate selling at mid.
  // - If CLOB returns 404 (market closed/resolved) → query Gamma API for settlement value.
  const tokenIds = toZero.map(p => p.tokenId);
  const midPrices = await fetchMidPrices(clobUrl, tokenIds);

  // Tokens with no CLOB mid are resolved markets — get settlement value from Gamma API.
  const resolvedTokenIds = tokenIds.filter(t => !midPrices.has(t));
  let resolutionValues = new Map<string, number>();
  if (resolvedTokenIds.length > 0) {
    resolutionValues = await fetchTokenResolutionValues(resolvedTokenIds);
  }

  let cashCredit = 0;
  for (const pos of toZero) {
    const mid = midPrices.get(pos.tokenId);
    if (mid !== undefined) {
      // Leader sold; CLOB market still active. Simulate paper exit at current mid.
      cashCredit += pos.size * mid;
    } else {
      // Market resolved. Credit at settlement value (1.0 = YES won, 0.0 = NO lost).
      const settlementValue = resolutionValues.get(pos.tokenId);
      if (settlementValue !== undefined && settlementValue > 0) {
        cashCredit += pos.size * settlementValue;
      } else {
        // Resolution = 0 or unknown — full loss. Fire Discord alert with cost basis.
        const costBasis = Number((pos.size * pos.avgPrice).toFixed(2));
        if (costBasis >= 0.01) {
          discord.send(`🔴 **ZERO RESOLUTION** (paper) — position resolved at $0.00\n> token: \`${pos.tokenId.slice(0, 16)}\` | cost basis: \$${costBasis} | full loss`);
        }
      }
    }
  }

  await prisma.position.updateMany({
    where: { profileId, tokenId: { in: tokenIds } },
    data: { size: 0, updatedAt: new Date() }
  });
  for (const pos of toZero) {
    state.positions.set(pos.tokenId, 0);
    state.conditionByToken.delete(pos.tokenId);
  }
  if (cashCredit > 0) {
    state.cashUSDC = Number((state.cashUSDC + cashCredit).toFixed(4));
    await setRuntimeMetric(prisma, profileId, "bot.cash_usdc", String(state.cashUSDC));
  }

  // Write synthetic SELL fills so getPositionSummaries shows correct P&L.
  // Without these, the closed-without-SELL path treats the entire cost basis as a
  // loss (realizedPnl -= openCost → -100% on every synced close).
  const closeTs = new Date();
  for (const pos of toZero) {
    const closePrice = midPrices.get(pos.tokenId) ?? resolutionValues.get(pos.tokenId) ?? 0;
    if (closePrice <= 0) continue; // True loss — no fill needed, -100% is correct
    try {
      const intentId = await createCopyIntent(prisma, profileId, {
        leaderEventId: "paper-sync",
        tokenId: pos.tokenId,
        side: "SELL",
        leaderSize: pos.size,
        desiredNotional: pos.size * closePrice,
        desiredSize: pos.size,
        status: "SETTLED",
        reason: "PAPER_SYNC_CLOSE",
        mode: "PAPER"
      });
      const orderId = await createOrder(prisma, profileId, {
        intentId,
        side: "SELL",
        price: closePrice,
        size: pos.size,
        status: "FILLED"
      });
      await createFill(prisma, profileId, {
        orderId,
        price: closePrice,
        size: pos.size,
        fee: 0,
        liquiditySide: "MAKER"
      });
    } catch (fillErr) {
      console.error(`syncPaperPositions: failed to write synthetic fill for ${pos.tokenId.slice(-12)}: ${fillErr}`);
    }
  }

  console.log(`syncPaperPositions: zeroed ${toZero.length} positions (${tokenIds.length - resolvedTokenIds.length} active-exit, ${resolvedTokenIds.length} resolved), returned $${cashCredit.toFixed(4)} to cash`);
  await createAlert(prisma, profileId, "INFO", "PAPER_POSITIONS_SYNCED",
    `Paper sync: zeroed ${toZero.length} resolved/exited positions`,
    { count: toZero.length, cashCredit: Number(cashCredit.toFixed(4)), sample: tokenIds.slice(0, 5) }
  );
}

async function syncRuntimeControl(): Promise<void> {
  const activeConfig = await ensureActiveConfigVersion(prisma, profileId, config);
  runtimeControl.killSwitch = activeConfig.safety.killSwitch;
  runtimeControl.paused = activeConfig.safety.paused;
  // Allow runtime config updates (from API/scripts) without restarting worker.
  config.budget.maxDailyNotionalUSDC = activeConfig.budget.maxDailyNotionalUSDC;
}

async function ensurePaperStartupUnpaused(): Promise<void> {
  if (config.mode !== "PAPER") {
    return;
  }

  await syncRuntimeControl();
  if (!runtimeControl.killSwitch && !runtimeControl.paused) {
    return;
  }

  await setRuntimeControlState(
    prisma,
    profileId,
    {
      killSwitch: false,
      paused: false
    },
    "bot-worker",
    "Auto-reset runtime control for PAPER startup",
    config
  );
  runtimeControl.killSwitch = false;
  runtimeControl.paused = false;
}

// In LIVE mode, a drawdown stop from a previous session can leave paused=true
// persisted in the active ConfigVersion. On restart the daily drawdown counter
// resets (startingUSDC anchors to the current wallet balance), so continuing to
// block trades due to a stale stop would silently lose the whole day. Auto-clear
// on every LIVE boot — if the operator wants the bot to stay paused they should
// leave it paused via the dashboard before starting, or the guardian will re-stop
// it if the drawdown limit is hit again within the new session.
async function ensureLiveStartupUnpaused(): Promise<void> {
  if (config.mode !== "LIVE") {
    return;
  }

  await syncRuntimeControl();
  if (!runtimeControl.killSwitch && !runtimeControl.paused) {
    return;
  }

  await setRuntimeControlState(
    prisma,
    profileId,
    {
      killSwitch: false,
      paused: false
    },
    "bot-worker",
    "Auto-reset runtime control for LIVE startup (stale pause from previous session)",
    config
  );
  runtimeControl.killSwitch = false;
  runtimeControl.paused = false;
  haltedByDrawdown = false;
}

async function drainQueue(): Promise<void> {
  if (processing) {
    return;
  }
  processing = true;

  try {
    while (eventQueue.length > 0) {
      const event = eventQueue.shift();
      if (!event) {
        break;
      }
      await processEvent(event);
    }
  } catch (error) {
    await createAlert(prisma, profileId, "ERROR", "PIPELINE_ERROR", "Unhandled error in copy pipeline", {
      message: error instanceof Error ? error.message : String(error)
    });
  } finally {
    processing = false;
  }
}

async function sendPeriodicStatusUpdate(): Promise<void> {
  const [openPositions, closedPositions, todayStats, openPositionRows] = await Promise.all([
    prisma.position.count({ where: { profileId, size: { gt: 0 } } }),
    prisma.position.count({ where: { profileId, size: { lte: 0 } } }),
    prisma.copyIntent.groupBy({
      by: ["status"],
      where: {
        profileId,
        ts: { gte: getTradingDayStart() }
      },
      _count: { _all: true }
    }),
    prisma.position.findMany({
      where: { profileId, size: { gt: 0 } },
      select: { size: true, avgPrice: true }
    })
  ]);

  const statsMap = new Map(todayStats.map((row) => [row.status, row._count._all]));
  const todayPlaced = statsMap.get("PLACED") ?? 0;
  const todayFilled = (statsMap.get("FILLED") ?? 0) + (statsMap.get("PARTIALLY_FILLED_OK") ?? 0);
  const todaySkipped = statsMap.get("SKIPPED") ?? 0;
  const todayRejected = statsMap.get("REJECTED") ?? 0;

  const costBasisOpen = openPositionRows.reduce((sum, row) => sum + row.size * row.avgPrice, 0);
  const totalEquity = Number((state.cashUSDC + costBasisOpen).toFixed(4));
  const netPnlUSDC = Number((totalEquity - startingUSDC).toFixed(4));

  const lines = [
    `🧭 **30m status** | time: ${new Date().toISOString()}`,
    `uptime: ${formatDuration(Date.now() - startedAtMs)} | profile: \`${profileId}\` | mode: ${config.mode}`,
    `control: paused=${runtimeControl.paused} killSwitch=${runtimeControl.killSwitch} haltedByDrawdown=${haltedByDrawdown}`,
    `feed: eventsSeen=${counters.eventsSeen} queueDepth=${eventQueue.length}`,
    `trades(startup): fills=${counters.fills} placed=${counters.intentsPlaced} skipped=${counters.intentsSkipped} rejected=${counters.intentsRejected}`,
    `trades(today): filled=${todayFilled} placed=${todayPlaced} skipped=${todaySkipped} rejected=${todayRejected}`,
    `portfolio: cash=$${state.cashUSDC.toFixed(2)} equity~$${totalEquity.toFixed(2)} pnl~$${netPnlUSDC.toFixed(2)} drawdown=$${lastComputedDrawdownUSDC.toFixed(2)}`,
    `positions: open=${openPositions} closed=${closedPositions} dailyNotional=$${state.dailyNotionalUSDC.toFixed(2)} / $${config.budget.maxDailyNotionalUSDC.toFixed(2)}`
  ];
  discord.send(lines.join("\n"));
}

async function startBotWorker(): Promise<void> {
  await syncActiveConfigVersion(prisma, profileId, config);
  await setRuntimeMetric(prisma, profileId, "bot.mode", config.mode);

  if (config.mode === "LIVE") {
    await hydrateLiveRuntimeState();
    await ensureLiveStartupUnpaused();
    // Anchor drawdown baseline to real wallet balance so that sessions starting
    // after claims/deposits correctly reflect the current capital, not the
    // hardcoded default.  Env var STARTING_USDC can still override this.
    if (!process.env.STARTING_USDC) {
      startingUSDC = state.cashUSDC;
    }
  } else {
    await ensurePaperStartupUnpaused();
    await hydratePaperRuntimeState();
  }

  // Seed drawdownDayKey to the current trading day so the first reconcile cycle
  // does not immediately treat today as a "new day" and incorrectly reset startingUSDC.
  drawdownDayKey = getTradingDayKey();

  await syncRuntimeControl();

  console.log("bot-worker starting", {
    mode: config.mode,
    leader: config.leader.wallet,
    profileId,
    startingUSDC,
    hydratedCashUSDC: state.cashUSDC
  });
  discord.send(`🤖 **Bot started** | leader: \`${config.leader.wallet}\` | cash: \$${state.cashUSDC}`);

  feed.onEvent((event) => {
    eventQueue.push(event);
    fireAndForget(setRuntimeMetric(prisma, profileId, "bot.feed.last_event_ts", String(event.ts)), "setRuntimeMetric:last_event_ts");
    fireAndForget(setRuntimeMetric(prisma, profileId, "bot.feed.last_event_token", event.tokenId), "setRuntimeMetric:last_event_token");
  });

  setInterval(() => {
    fireAndForget(drainQueue(), "drainQueue");
  }, 250);

  setInterval(() => {
    fireAndForget(runReconcileChecks(), "runReconcileChecks");
  }, config.safety.reconcileIntervalSeconds * 1000);

  setInterval(() => {
    fireAndForget(syncRuntimeControl(), "syncRuntimeControl");
  }, 5000);

  setInterval(() => {
    const stats = feed.getStats();
    fireAndForget(setRuntimeMetric(prisma, profileId, "bot.heartbeat_ts", String(Date.now())), "setRuntimeMetric:heartbeat_ts");
    fireAndForget(setRuntimeMetric(prisma, profileId, "bot.feed.events_seen", String(stats.eventsSeen)), "setRuntimeMetric:events_seen");
    fireAndForget(setRuntimeMetric(prisma, profileId, "bot.feed.mode", stats.mode), "setRuntimeMetric:feed_mode");
    fireAndForget(setRuntimeMetric(prisma, profileId, "bot.feed.last_poll_ts", String(stats.lastPollTs ?? 0)), "setRuntimeMetric:last_poll_ts");
    fireAndForget(setRuntimeMetric(prisma, profileId, "bot.feed.last_error", stats.lastError ?? ""), "setRuntimeMetric:last_error");
    fireAndForget(setRuntimeMetric(prisma, profileId, "bot.queue_depth", String(eventQueue.length)), "setRuntimeMetric:queue_depth");
    fireAndForget(setRuntimeMetric(prisma, profileId, "bot.cash_usdc", String(state.cashUSDC)), "setRuntimeMetric:cash_usdc");
    fireAndForget(setRuntimeMetric(prisma, profileId, "bot.drawdown_usdc", String(lastComputedDrawdownUSDC)), "setRuntimeMetric:drawdown_usdc");
    fireAndForget(setRuntimeMetric(prisma, profileId, "bot.open_orders", "0"), "setRuntimeMetric:open_orders");
  }, config.execution.heartbeatIntervalSeconds * 1000);

  setInterval(() => {
    const stats = feed.getStats();
    console.log("bot-worker status", {
      ts: Date.now(),
      mode: config.mode,
      feedMode: config.leader.feedMode,
      leader: config.leader.wallet,
      stats,
      counters,
      queueDepth: eventQueue.length,
      cashUSDC: state.cashUSDC,
      runtimeControl,
      drawdownUSDC: lastComputedDrawdownUSDC,
      haltedByDrawdown,
      openMarkets: Array.from(state.positions.values()).filter((size) => size > 0).length,
      dailyNotionalUSDC: state.dailyNotionalUSDC
    });
  }, 30000);

  setInterval(() => {
    fireAndForget(sendPeriodicStatusUpdate(), "sendPeriodicStatusUpdate");
  }, 30 * 60 * 1000);
}

void startBotWorker().catch(async (error) => {
  discord.send(`💥 **Bot crashed**: ${error instanceof Error ? error.message : String(error)}`);
  await createAlert(prisma, profileId, "ERROR", "BOT_STARTUP_ERROR", "bot-worker failed to start", {
    message: error instanceof Error ? error.message : String(error)
  });
  console.error("bot-worker failed to start", error);
  process.exit(1);
});

process.on("SIGINT", async () => {
  discord.send("🛑 **Bot stopped** (shutdown signal received)");
  feed.stop();
  await prisma.$disconnect();
  process.exit(0);
});
