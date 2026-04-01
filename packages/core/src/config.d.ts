import { z } from "zod";
import type { CopybotConfig } from "./types.js";
export declare const copybotConfigSchema: z.ZodObject<{
    mode: z.ZodEnum<["PAPER", "LIVE"]>;
    leader: z.ZodObject<{
        wallet: z.ZodString;
        copyBuys: z.ZodBoolean;
        copySells: z.ZodBoolean;
    }, "strip", z.ZodTypeAny, {
        wallet: string;
        copyBuys: boolean;
        copySells: boolean;
    }, {
        wallet: string;
        copyBuys: boolean;
        copySells: boolean;
    }>;
    budget: z.ZodObject<{
        reserveUSDC: z.ZodNumber;
        safetyBufferUSDC: z.ZodNumber;
        perTradeNotionalUSDC: z.ZodNumber;
        minTradeNotionalUSDC: z.ZodNumber;
        maxTradeNotionalUSDC: z.ZodNumber;
        maxNotionalPerMarketUSDC: z.ZodNumber;
        maxOpenMarkets: z.ZodNumber;
        maxDailyNotionalUSDC: z.ZodNumber;
        maxDailyDrawdownUSDC: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        reserveUSDC: number;
        safetyBufferUSDC: number;
        perTradeNotionalUSDC: number;
        minTradeNotionalUSDC: number;
        maxTradeNotionalUSDC: number;
        maxNotionalPerMarketUSDC: number;
        maxOpenMarkets: number;
        maxDailyNotionalUSDC: number;
        maxDailyDrawdownUSDC: number;
    }, {
        reserveUSDC: number;
        safetyBufferUSDC: number;
        perTradeNotionalUSDC: number;
        minTradeNotionalUSDC: number;
        maxTradeNotionalUSDC: number;
        maxNotionalPerMarketUSDC: number;
        maxOpenMarkets: number;
        maxDailyNotionalUSDC: number;
        maxDailyDrawdownUSDC: number;
    }>;
    execution: z.ZodObject<{
        style: z.ZodLiteral<"TAKER">;
        maxTradesPerMinute: z.ZodNumber;
        maxSpreadBps: z.ZodNumber;
        maxSlippageBps: z.ZodNumber;
        maxChaseSeconds: z.ZodNumber;
        maxRetries: z.ZodNumber;
        acceptPartialFillAndStop: z.ZodBoolean;
        maxEventAgeMs: z.ZodNumber;
        maxLeaderToSubmitMs: z.ZodNumber;
        topOfBookDepthMultiple: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
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
    }, {
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
    }>;
    safety: z.ZodObject<{
        killSwitch: z.ZodBoolean;
        pauseOnErrorStorm: z.ZodBoolean;
        errorStorm: z.ZodObject<{
            maxErrors: z.ZodNumber;
            windowSeconds: z.ZodNumber;
            pauseSeconds: z.ZodNumber;
        }, "strip", z.ZodTypeAny, {
            maxErrors: number;
            windowSeconds: number;
            pauseSeconds: number;
        }, {
            maxErrors: number;
            windowSeconds: number;
            pauseSeconds: number;
        }>;
        reconcileIntervalSeconds: z.ZodNumber;
        wsStaleSeconds: z.ZodNumber;
        reconnectBackfillSeconds: z.ZodNumber;
        confirmBackfillSeconds: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
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
    }, {
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
    }>;
    filters: z.ZodObject<{
        minPrice: z.ZodNumber;
        maxPrice: z.ZodNumber;
        blacklistConditionIds: z.ZodArray<z.ZodString, "many">;
        blacklistTokenIds: z.ZodArray<z.ZodString, "many">;
        excludeFeeEnabledMarkets: z.ZodBoolean;
        excludeLowLiquidityMarkets: z.ZodBoolean;
    }, "strip", z.ZodTypeAny, {
        minPrice: number;
        maxPrice: number;
        blacklistConditionIds: string[];
        blacklistTokenIds: string[];
        excludeFeeEnabledMarkets: boolean;
        excludeLowLiquidityMarkets: boolean;
    }, {
        minPrice: number;
        maxPrice: number;
        blacklistConditionIds: string[];
        blacklistTokenIds: string[];
        excludeFeeEnabledMarkets: boolean;
        excludeLowLiquidityMarkets: boolean;
    }>;
}, "strip", z.ZodTypeAny, {
    mode: "PAPER" | "LIVE";
    leader: {
        wallet: string;
        copyBuys: boolean;
        copySells: boolean;
    };
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
        excludeFeeEnabledMarkets: boolean;
        excludeLowLiquidityMarkets: boolean;
    };
}, {
    mode: "PAPER" | "LIVE";
    leader: {
        wallet: string;
        copyBuys: boolean;
        copySells: boolean;
    };
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
        excludeFeeEnabledMarkets: boolean;
        excludeLowLiquidityMarkets: boolean;
    };
}>;
export declare function buildDefaultConfig(): CopybotConfig;
