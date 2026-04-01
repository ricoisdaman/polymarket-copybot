export type BotMode = "PAPER" | "LIVE";
export type TradeSide = "BUY" | "SELL";
export type LeaderConfig = {
    wallet: string;
    copyBuys: boolean;
    copySells: boolean;
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
        maxTradesPerMinute: number;
        maxSpreadBps: number;
        maxSlippageBps: number;
        maxChaseSeconds: number;
        maxRetries: number;
        acceptPartialFillAndStop: boolean;
        maxEventAgeMs: number;
        maxLeaderToSubmitMs: number;
        topOfBookDepthMultiple: number;
    };
    safety: {
        killSwitch: boolean;
        pauseOnErrorStorm: boolean;
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
export type CopyIntentStatus = "SKIPPED" | "PLACED" | "FILLED" | "PARTIALLY_FILLED_OK" | "REJECTED";
export type SkipReason = "KILL_SWITCH" | "EVENT_TOO_OLD" | "COPY_SIDE_DISABLED" | "PRICE_FILTER" | "INSUFFICIENT_AVAILABLE_AFTER_RESERVE" | "SPREAD_TOO_WIDE" | "SLIPPAGE_TOO_HIGH" | "INSUFFICIENT_LIQUIDITY" | "MAX_OPEN_MARKETS" | "MAX_NOTIONAL_PER_MARKET" | "MAX_DAILY_NOTIONAL" | "NO_POSITION_TO_SELL" | "DUPLICATE_EVENT" | "TITLE_BLOCKED";
export type QuoteEstimate = {
    tokenId: string;
    side: TradeSide;
    bestBid: number;
    bestAsk: number;
    executablePrice: number;
    spreadBps: number;
    slippageBps: number;
    topOfBookDepth: number;
};
export type RiskDecision = {
    allowed: true;
    desiredNotional: number;
    desiredSize: number;
} | {
    allowed: false;
    reason: SkipReason;
};
