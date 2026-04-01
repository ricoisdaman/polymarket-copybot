import { z } from "zod";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, parse } from "node:path";
import type { CopybotConfig } from "./types.js";

export const copybotConfigSchema = z.object({
  mode: z.enum(["PAPER", "LIVE"]),
  leader: z.object({
    wallet: z.string().min(3),
    copyBuys: z.boolean(),
    copySells: z.boolean(),
    feedMode: z.enum(["SIMULATED", "DATA_API_POLL"]),
    pollIntervalSeconds: z.number().int().positive(),
    sellFullPositionOnLeaderSell: z.boolean()
  }),
  budget: z.object({
    reserveUSDC: z.number().nonnegative(),
    safetyBufferUSDC: z.number().nonnegative(),
    perTradeNotionalUSDC: z.number().positive(),
    minTradeNotionalUSDC: z.number().positive(),
    maxTradeNotionalUSDC: z.number().positive(),
    maxNotionalPerMarketUSDC: z.number().positive(),
    maxOpenMarkets: z.number().int().positive(),
    maxDailyNotionalUSDC: z.number().positive(),
    maxDailyDrawdownUSDC: z.number().positive()
  }),
  execution: z.object({
    style: z.literal("TAKER"),
    heartbeatIntervalSeconds: z.number().int().positive(),
    maxTradesPerMinute: z.number().int().positive(),
    maxSpreadBps: z.number().int().positive(),
    maxSlippageBps: z.number().int().positive(),
    maxChaseSeconds: z.number().int().positive(),
    maxRetries: z.number().int().nonnegative(),
    acceptPartialFillAndStop: z.boolean(),
    minOrderNotionalUSDC: z.number().positive(),
    minOrderShares: z.number().positive(),
    strictVenueConstraintsInPaper: z.boolean(),
    maxEventAgeMs: z.number().int().positive(),
    maxLeaderToSubmitMs: z.number().int().positive(),
    topOfBookDepthMultiple: z.number().positive(),
    takeProfitBps: z.number().int().nonnegative(),
    minMarketAgeRemainingMs: z.number().int().nonnegative()
  }),
  safety: z.object({
    killSwitch: z.boolean(),
    paused: z.boolean(),
    pauseOnErrorStorm: z.boolean(),
    botHeartbeatStaleSeconds: z.number().int().positive(),
    errorStorm: z.object({
      maxErrors: z.number().int().positive(),
      windowSeconds: z.number().int().positive(),
      pauseSeconds: z.number().int().positive()
    }),
    reconcileIntervalSeconds: z.number().int().positive(),
    wsStaleSeconds: z.number().int().positive(),
    reconnectBackfillSeconds: z.number().int().positive(),
    confirmBackfillSeconds: z.number().int().positive()
  }),
  filters: z.object({
    minPrice: z.number().gt(0).lte(1),
    maxPrice: z.number().gt(0).lte(1),
    blacklistConditionIds: z.array(z.string()),
    blacklistTokenIds: z.array(z.string()),
    blockedTitleKeywords: z.array(z.string()).default([]),
    excludeFeeEnabledMarkets: z.boolean(),
    excludeLowLiquidityMarkets: z.boolean()
  })
});

let cachedFileEnv: Record<string, string> | null = null;

function parseEnvFile(content: string): Record<string, string> {
  const values: Record<string, string> = {};
  const lines = content.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) {
      continue;
    }
    const key = match[1];
    let value = match[2] ?? "";
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

function findNearestEnvFile(startDir: string): string | null {
  let currentDir = startDir;
  const rootDir = parse(startDir).root;

  while (true) {
    const candidate = join(currentDir, ".env");
    if (existsSync(candidate)) {
      return candidate;
    }
    if (currentDir === rootDir) {
      return null;
    }
    currentDir = dirname(currentDir);
  }
}

function getFileEnv(): Record<string, string> {
  if (cachedFileEnv) {
    return cachedFileEnv;
  }
  const envFile = findNearestEnvFile(process.cwd());
  if (!envFile) {
    cachedFileEnv = {};
    return cachedFileEnv;
  }
  const content = readFileSync(envFile, "utf8");
  cachedFileEnv = parseEnvFile(content);
  return cachedFileEnv;
}

function getEnvValue(key: string): string | undefined {
  return process.env[key] ?? getFileEnv()[key];
}

export function buildDefaultConfig(): CopybotConfig {
  const mode = getEnvValue("BOT_MODE") === "LIVE" ? "LIVE" : "PAPER";
  const feedMode = getEnvValue("LEADER_FEED_MODE") === "DATA_API_POLL" ? "DATA_API_POLL" : "SIMULATED";
  const pollIntervalSeconds = Number(getEnvValue("LEADER_POLL_INTERVAL_SECONDS") ?? 2);
  // 10-second window for DATA_API_POLL: polls run every 2s so events arrive within 2-4s
  // of happening. 10s gives ~4 missed-poll buffer without acting on stale signals.
  // Override via MAX_EVENT_AGE_MS if you need a larger window for paper replay testing.
  const defaultEventAgeMs = feedMode === "DATA_API_POLL" ? 10000 : 3000;
  const maxEventAgeMsEnv = Number(getEnvValue("MAX_EVENT_AGE_MS") ?? defaultEventAgeMs);
  const maxDailyNotionalEnv = Number(getEnvValue("MAX_DAILY_NOTIONAL_USDC") ?? 25);
  const minOrderNotionalEnv = Number(getEnvValue("MIN_ORDER_NOTIONAL_USDC") ?? 1);
  const minOrderSharesEnv = Number(getEnvValue("MIN_ORDER_SHARES") ?? 5);
  const strictVenueConstraintsInPaper = getEnvValue("STRICT_VENUE_CONSTRAINTS_IN_PAPER") === "true";
  const perTradeNotionalEnv = Number(getEnvValue("PER_TRADE_NOTIONAL_USDC") ?? 5);
  const maxTradeNotionalEnv = Number(getEnvValue("MAX_TRADE_NOTIONAL_USDC") ?? 6);
  const minPriceFilterEnv = Number(getEnvValue("MIN_PRICE_FILTER") ?? 0.01);
  const maxPriceFilterEnv = Number(getEnvValue("MAX_PRICE_FILTER") ?? 0.9999);
  const maxOpenMarketsEnv = Number(getEnvValue("MAX_OPEN_MARKETS") ?? 25);
  const maxNotionalPerMarketEnv = Number(getEnvValue("MAX_NOTIONAL_PER_MARKET_USDC") ?? 5);
  const reserveUSDCEnv = Number(getEnvValue("RESERVE_USDC") ?? 5);
  const blockedTitleKeywordsRaw = getEnvValue("BLOCKED_TITLE_KEYWORDS") ?? "";
  const blockedTitleKeywords = blockedTitleKeywordsRaw
    .split(",")
    .map((k) => k.trim().toLowerCase())
    .filter((k) => k.length > 0);
  const maxChaseSecondsEnv = Number(getEnvValue("MAX_CHASE_SECONDS") ?? 30);

  const config: CopybotConfig = {
    mode,
    leader: {
      wallet: getEnvValue("LEADER_WALLET") ?? "0xLEADER...",
      copyBuys: true,
      copySells: true,
      feedMode,
      pollIntervalSeconds: Number.isFinite(pollIntervalSeconds) && pollIntervalSeconds > 0 ? pollIntervalSeconds : 2,
      sellFullPositionOnLeaderSell: true
    },
    budget: {
      reserveUSDC: Number.isFinite(reserveUSDCEnv) && reserveUSDCEnv >= 0 ? reserveUSDCEnv : 5,
      safetyBufferUSDC: 0.25,
      perTradeNotionalUSDC: Number.isFinite(perTradeNotionalEnv) && perTradeNotionalEnv > 0 ? perTradeNotionalEnv : 5,
      minTradeNotionalUSDC: 0.5,
      maxTradeNotionalUSDC: Number.isFinite(maxTradeNotionalEnv) && maxTradeNotionalEnv > 0 ? maxTradeNotionalEnv : 6,
      maxNotionalPerMarketUSDC: Number.isFinite(maxNotionalPerMarketEnv) && maxNotionalPerMarketEnv > 0 ? maxNotionalPerMarketEnv : 5,
      maxOpenMarkets: Number.isFinite(maxOpenMarketsEnv) && maxOpenMarketsEnv > 0 ? maxOpenMarketsEnv : 25,
      maxDailyNotionalUSDC: Number.isFinite(maxDailyNotionalEnv) && maxDailyNotionalEnv > 0 ? maxDailyNotionalEnv : 25,
      maxDailyDrawdownUSDC: 30
    },
    execution: {
      style: "TAKER",
      heartbeatIntervalSeconds: 5,
      maxTradesPerMinute: 10,
      maxSpreadBps: 1500,
      maxSlippageBps: 50,
      maxChaseSeconds: Number.isFinite(maxChaseSecondsEnv) && maxChaseSecondsEnv > 0 ? maxChaseSecondsEnv : 30,
      maxRetries: 2,
      acceptPartialFillAndStop: true,
      minOrderNotionalUSDC: Number.isFinite(minOrderNotionalEnv) && minOrderNotionalEnv > 0 ? minOrderNotionalEnv : 1,
      minOrderShares: Number.isFinite(minOrderSharesEnv) && minOrderSharesEnv > 0 ? minOrderSharesEnv : 5,
      strictVenueConstraintsInPaper,
      maxEventAgeMs: Number.isFinite(maxEventAgeMsEnv) && maxEventAgeMsEnv > 0 ? maxEventAgeMsEnv : defaultEventAgeMs,
      maxLeaderToSubmitMs: 3000,
      topOfBookDepthMultiple: 3,
      takeProfitBps: Number(getEnvValue("TAKE_PROFIT_BPS") ?? 0),
      minMarketAgeRemainingMs: Number(getEnvValue("MIN_MARKET_AGE_REMAINING_MS") ?? 0)
    },
    safety: {
      killSwitch: false,
      paused: false,
      pauseOnErrorStorm: true,
      botHeartbeatStaleSeconds: 120,
      errorStorm: {
        maxErrors: 10,
        windowSeconds: 60,
        pauseSeconds: 120
      },
      reconcileIntervalSeconds: 30,
      wsStaleSeconds: 10,
      reconnectBackfillSeconds: 120,
      confirmBackfillSeconds: 90
    },
    filters: {
      minPrice: Number.isFinite(minPriceFilterEnv) && minPriceFilterEnv > 0 ? minPriceFilterEnv : 0.01,
      maxPrice: Number.isFinite(maxPriceFilterEnv) && maxPriceFilterEnv > 0 ? maxPriceFilterEnv : 0.9999,
      blacklistConditionIds: [],
      blacklistTokenIds: [],
      blockedTitleKeywords,
      excludeFeeEnabledMarkets: true,
      excludeLowLiquidityMarkets: true
    }
  };

  return copybotConfigSchema.parse(config);
}
