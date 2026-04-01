export type BotMode = "PAPER" | "LIVE";
export type TradeSide = "BUY" | "SELL";

export type LeaderConfig = {
  wallet: string;
  copyBuys: boolean;
  copySells: boolean;
  feedMode: "SIMULATED" | "DATA_API_POLL";
  pollIntervalSeconds: number;
  /** When true, a leader SELL closes our entire position rather than a fixed-notional slice. */
  sellFullPositionOnLeaderSell: boolean;
};

export type CopybotConfig = {
  mode: BotMode;
  leader: LeaderConfig;
  budget: {
    reserveUSDC: number;
    safetyBufferUSDC: number;
    perTradeNotionalUSDC: number;
    minTradeNotionalUSDC: number;
    maxTradeNotionalUSDC: number;
    maxNotionalPerMarketUSDC: number;
    maxOpenMarkets: number;
    maxDailyNotionalUSDC: number;
    maxDailyDrawdownUSDC: number;
  };
  execution: {
    style: "TAKER";
    heartbeatIntervalSeconds: number;
    maxTradesPerMinute: number;
    maxSpreadBps: number;
    maxSlippageBps: number;
    maxChaseSeconds: number;
    maxRetries: number;
    acceptPartialFillAndStop: boolean;
    minOrderNotionalUSDC: number;
    minOrderShares: number;
    strictVenueConstraintsInPaper: boolean;
    maxEventAgeMs: number;
    maxLeaderToSubmitMs: number;
    topOfBookDepthMultiple: number;
    /** Auto-sell a position when unrealized gain exceeds this threshold (bps). 0 = disabled. */
    takeProfitBps: number;
    /** Skip buys when fewer than this many ms remain until market expiry (0 = disabled). */
    minMarketAgeRemainingMs: number;
  };
  safety: {
    killSwitch: boolean;
    paused: boolean;
    pauseOnErrorStorm: boolean;
    botHeartbeatStaleSeconds: number;
    errorStorm: {
      maxErrors: number;
      windowSeconds: number;
      pauseSeconds: number;
    };
    reconcileIntervalSeconds: number;
    wsStaleSeconds: number;
    reconnectBackfillSeconds: number;
    confirmBackfillSeconds: number;
  };
  filters: {
    minPrice: number;
    maxPrice: number;
    blacklistConditionIds: string[];
    blacklistTokenIds: string[];
    blockedTitleKeywords: string[];
    excludeFeeEnabledMarkets: boolean;
    excludeLowLiquidityMarkets: boolean;
  };
};

export type LeaderEvent = {
  eventId: string;
  dedupeKey: string;
  ts: number;
  leaderWallet: string;
  conditionId: string;
  tokenId: string;
  side: TradeSide;
  price: number;
  size: number;
  usdcSize: number;
  source: "PUBLIC_WS";
  raw: Record<string, unknown>;
};

export type CopyIntentStatus =
  | "SKIPPED"
  | "PLACED"
  | "FILLED"
  | "PARTIALLY_FILLED_OK"
  | "REJECTED";

export type SkipReason =
  | "KILL_SWITCH"
  | "PAUSED"
  | "DRAWDOWN_STOP"
  | "EVENT_TOO_OLD"
  | "COPY_SIDE_DISABLED"
  | "PRICE_FILTER"
  | "INSUFFICIENT_AVAILABLE_AFTER_RESERVE"
  | "SPREAD_TOO_WIDE"
  | "SLIPPAGE_TOO_HIGH"
  | "INSUFFICIENT_LIQUIDITY"
  | "MAX_OPEN_MARKETS"
  | "MAX_NOTIONAL_PER_MARKET"
  | "MAX_DAILY_NOTIONAL"
  | "MIN_ORDER_NOTIONAL"
  | "MIN_ORDER_SHARES"
  | "NO_POSITION_TO_SELL"
  | "DUPLICATE_EVENT"
  | "TITLE_BLOCKED";

export type QuoteEstimate = {
  tokenId: string;
  side: TradeSide;
  bestBid: number;
  bestAsk: number;
  executablePrice: number;
  spreadBps: number;
  slippageBps: number;
  topOfBookDepth: number;
  /** Shares that the book-walk could actually fill at the time of quoting. */
  filledSize: number;
};

export type RiskDecision =
  | { allowed: true; desiredNotional: number; desiredSize: number }
  | { allowed: false; reason: SkipReason };
