import { z } from "zod";
export const copybotConfigSchema = z.object({
    mode: z.enum(["PAPER", "LIVE"]),
    leader: z.object({
        wallet: z.string().min(3),
        copyBuys: z.boolean(),
        copySells: z.boolean()
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
        maxTradesPerMinute: z.number().int().positive(),
        maxSpreadBps: z.number().int().positive(),
        maxSlippageBps: z.number().int().positive(),
        maxChaseSeconds: z.number().int().positive(),
        maxRetries: z.number().int().nonnegative(),
        acceptPartialFillAndStop: z.boolean(),
        maxEventAgeMs: z.number().int().positive(),
        maxLeaderToSubmitMs: z.number().int().positive(),
        topOfBookDepthMultiple: z.number().positive()
    }),
    safety: z.object({
        killSwitch: z.boolean(),
        pauseOnErrorStorm: z.boolean(),
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
        minPrice: z.number().gt(0).lt(1),
        maxPrice: z.number().gt(0).lt(1),
        blacklistConditionIds: z.array(z.string()),
        blacklistTokenIds: z.array(z.string()),
        excludeFeeEnabledMarkets: z.boolean(),
        excludeLowLiquidityMarkets: z.boolean()
    })
});
export function buildDefaultConfig() {
    const config = {
        mode: "PAPER",
        leader: {
            wallet: process.env.LEADER_WALLET ?? "0xLEADER...",
            copyBuys: true,
            copySells: true
        },
        budget: {
            reserveUSDC: 5,
            safetyBufferUSDC: 0.25,
            perTradeNotionalUSDC: 1,
            minTradeNotionalUSDC: 0.5,
            maxTradeNotionalUSDC: 2,
            maxNotionalPerMarketUSDC: 5,
            maxOpenMarkets: 10,
            maxDailyNotionalUSDC: 25,
            maxDailyDrawdownUSDC: 15
        },
        execution: {
            style: "TAKER",
            maxTradesPerMinute: 10,
            maxSpreadBps: 100,
            maxSlippageBps: 50,
            maxChaseSeconds: 8,
            maxRetries: 2,
            acceptPartialFillAndStop: true,
            maxEventAgeMs: 3000,
            maxLeaderToSubmitMs: 3000,
            topOfBookDepthMultiple: 3
        },
        safety: {
            killSwitch: false,
            pauseOnErrorStorm: true,
            errorStorm: {
                maxErrors: 5,
                windowSeconds: 60,
                pauseSeconds: 120
            },
            reconcileIntervalSeconds: 30,
            wsStaleSeconds: 10,
            reconnectBackfillSeconds: 120,
            confirmBackfillSeconds: 90
        },
        filters: {
            minPrice: 0.01,
            maxPrice: 0.99,
            blacklistConditionIds: [],
            blacklistTokenIds: [],
            excludeFeeEnabledMarkets: true,
            excludeLowLiquidityMarkets: true
        }
    };
    return copybotConfigSchema.parse(config);
}
