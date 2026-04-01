import cors from "cors";
import express from "express";
import { buildDefaultConfig, createDiscordNotifier } from "@copybot/core";
import {
  createDbClient,
  DEFAULT_PROFILE_ID,
  ensureActiveConfigVersion,
  getActiveControlState,
  getPipelineSummary,
  getPositionSummaries,
  getRuntimeMetric,
  getRuntimeMetricNumber,
  listProfiles,
  listRecentActivity,
  listRecentAlerts,
  listRuntimeMetrics,
  listRecentTimeline,
  setRuntimeControlState
} from "@copybot/db";
import { fetchMidPrices, fetchTokenResolutionValues } from "@copybot/polymarket";

const app = express();
const port = Number(process.env.PORT ?? 4000);
const defaultConfig = buildDefaultConfig();
const prisma = createDbClient();
const defaultProfileId = process.env.PROFILE_ID ?? DEFAULT_PROFILE_ID;

void ensureActiveConfigVersion(prisma, defaultProfileId, defaultConfig);

function getProfileId(req: express.Request): string {
  return String(req.query.profileId ?? defaultProfileId);
}

app.use(cors());
app.use(express.json());

app.get("/profiles/list", async (_req, res) => {
  const profiles = await listProfiles(prisma);
  res.json({ profiles });
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "api-server" });
});

app.get("/health/deep", async (req, res) => {
  const profileId = getProfileId(req);
  const [botHeartbeatTs, queueDepth, feedLastError] = await Promise.all([
    getRuntimeMetricNumber(prisma, profileId, "bot.heartbeat_ts"),
    getRuntimeMetricNumber(prisma, profileId, "bot.queue_depth"),
    getRuntimeMetric(prisma, profileId, "bot.feed.last_error")
  ]);
  const heartbeatAgeMs = botHeartbeatTs ? Date.now() - botHeartbeatTs : null;
  const ok = heartbeatAgeMs !== null ? heartbeatAgeMs < defaultConfig.safety.botHeartbeatStaleSeconds * 1000 : false;

  res.status(ok ? 200 : 503).json({
    ok,
    service: "api-server",
    botHeartbeatTs,
    heartbeatAgeMs,
    queueDepth,
    feedLastError: feedLastError?.value ?? ""
  });
});

app.get("/config/default", (_req, res) => {
  res.json(defaultConfig);
});

app.get("/activity/recent", async (req, res) => {
  const profileId = getProfileId(req);
  const limit = Number(req.query.limit ?? 50);
  const offset = Number(req.query.offset ?? 0);
  const mode = typeof req.query.mode === "string" ? req.query.mode : undefined;
  const safeLimit = Number.isFinite(limit) ? limit : 50;
  const safeOffset = Number.isFinite(offset) && offset >= 0 ? offset : 0;
  const { intents, total } = await listRecentActivity(prisma, profileId, safeLimit, safeOffset, mode);
  res.json({ count: intents.length, total, data: intents });
});

app.get("/alerts/recent", async (req, res) => {
  const profileId = getProfileId(req);
  const limit = Number(req.query.limit ?? 50);
  const since = req.query.since ? Number(req.query.since) : undefined;
  const data = await listRecentAlerts(prisma, profileId, Number.isFinite(limit) ? limit : 50, since);
  res.json({ count: data.length, data });
});

app.get("/status/summary", async (req, res) => {
  const profileId = getProfileId(req);
  const since = req.query.since ? Number(req.query.since) : undefined;
  const [summary, control, modeMetric] = await Promise.all([
    getPipelineSummary(prisma, profileId, since),
    getActiveControlState(prisma, profileId, defaultConfig),
    getRuntimeMetric(prisma, profileId, "bot.mode")
  ]);
  const profileMode = (modeMetric?.value === "LIVE" || modeMetric?.value === "PAPER")
    ? modeMetric.value as "LIVE" | "PAPER"
    : defaultConfig.mode;
  res.json({
    ...summary,
    mode: profileMode,
    control,
    ts: Date.now()
  });
});

app.get("/timeline/recent", async (req, res) => {
  const profileId = getProfileId(req);
  const limit = Number(req.query.limit ?? 30);
  const since = req.query.since ? Number(req.query.since) : undefined;
  const data = await listRecentTimeline(prisma, profileId, Number.isFinite(limit) ? limit : 30, since);
  res.json({ count: data.length, data });
});

app.get("/leader/activity", async (req, res) => {
  const limit = Math.min(100, Math.max(1, Number(req.query.limit ?? 50)));
  const leaderWallet = process.env.LEADER_WALLET ?? "";
  const dataApiBaseUrl = process.env.POLYMARKET_DATA_API_URL ?? "https://data-api.polymarket.com";

  if (!leaderWallet) {
    res.json({ count: 0, data: [], error: "LEADER_WALLET not configured" });
    return;
  }

  try {
    const url = `${dataApiBaseUrl.replace(/\/$/, "")}/activity?user=${encodeURIComponent(leaderWallet)}&limit=${limit}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) {
      res.status(502).json({ count: 0, data: [], error: `Data API returned ${response.status}` });
      return;
    }
    const payload = (await response.json()) as unknown;
    const records = Array.isArray(payload)
      ? payload
      : Array.isArray((payload as { data?: unknown[] }).data)
        ? ((payload as { data: unknown[] }).data ?? [])
        : [];

    const data = records
      .map((r: unknown) => {
        const rec = r as Record<string, unknown>;
        const rawTs = rec.timestamp ?? rec.ts ?? rec.time;
        const tsMs = typeof rawTs === "number"
          ? (rawTs > 10_000_000_000 ? rawTs : rawTs * 1000)
          : Date.parse(String(rawTs ?? ""));
        return {
          id: String(rec.id ?? rec.transactionHash ?? rec.txHash ?? ""),
          ts: Number.isFinite(tsMs) ? tsMs : Date.now(),
          tokenId: String(rec.tokenId ?? rec.token_id ?? rec.asset ?? ""),
          conditionId: String(rec.conditionId ?? rec.condition_id ?? ""),
          side: String(rec.side ?? "BUY").toUpperCase(),
          price: Number(rec.price ?? 0),
          size: Number(rec.size ?? 0),
          usdcSize: Number(rec.usdcSize ?? rec.usdc_size ?? 0),
          title: String(rec.title ?? ""),
          slug: String(rec.slug ?? ""),
          outcome: String(rec.outcome ?? ""),
        };
      })
      .filter((r) => r.tokenId && r.price > 0);

    res.json({ count: data.length, data });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ count: 0, data: [], error: msg });
  }
});

app.get("/positions/summary", async (req, res) => {
  const profileId = getProfileId(req);
  const since = req.query.since ? Number(req.query.since) : undefined;
  const data = await getPositionSummaries(prisma, profileId, since);

  // Mark open positions to market using live CLOB mid prices
  if (data.open.length > 0) {
    const clobBaseUrl = process.env.POLYMARKET_CLOB_API_URL ?? "https://clob.polymarket.com";
    const livePrices = await fetchMidPrices(clobBaseUrl, data.open.map((p) => p.tokenId));
    const priceTs = new Date().toISOString();
    if (livePrices.size > 0) {
      data.open = data.open.map((p) => {
        const livePrice = livePrices.get(p.tokenId);
        if (!livePrice) return p;
        const newCurrentValue = p.shares * livePrice;
        // pnl = realizedPnl + unrealizedPnl; unrealizedPnl shifts by the price delta
        const newPnl = p.pnl + p.shares * (livePrice - p.lastPrice);
        // updatedAt reflects when the mark price was last fetched, not just last fill
        return { ...p, lastPrice: livePrice, currentValue: newCurrentValue, pnl: newPnl, updatedAt: priceTs };
      });
    }
  }

  // Resolve WIN/LOSS for closed positions that were resolved on-chain (no SELL fill).
  // These have currentValue=0 and a negative pnl (full cost write-off).
  // The Gamma API returns the resolution price: 1=WIN, 0=LOSS.
  const onChainClosed = data.closed.filter((p) => p.currentValue === 0);
  if (onChainClosed.length > 0) {
    const resolutionValues = await fetchTokenResolutionValues(onChainClosed.map((p) => p.tokenId));
    if (resolutionValues.size > 0) {
      data.closed = data.closed.map((p) => {
        const rv = resolutionValues.get(p.tokenId);
        if (rv === undefined || p.currentValue !== 0) return p;
        // Correct P&L based on actual resolution: WIN = shares × 1.0 − cost; LOSS = −cost
        const correctPnl = Number(((rv * p.shares) - p.amount).toFixed(4));
        return { ...p, pnl: correctPnl, resolutionValue: rv } as typeof p & { resolutionValue: number };
      });
    }
  }

  res.json(data);
});

app.get("/control/state", async (req, res) => {
  const profileId = getProfileId(req);
  const control = await getActiveControlState(prisma, profileId, defaultConfig);
  res.json(control);
});

app.get("/metrics/runtime", async (req, res) => {
  const profileId = getProfileId(req);
  const prefix = String(req.query.prefix ?? "bot.");
  const metrics = await listRuntimeMetrics(prisma, profileId, prefix);
  res.json({ count: metrics.length, data: metrics });
});

app.post("/control/state", async (req, res) => {
  const profileId = getProfileId(req);
  const body = (req.body ?? {}) as { killSwitch?: boolean; paused?: boolean; reason?: string };
  const control = await setRuntimeControlState(
    prisma,
    profileId,
    {
      killSwitch: typeof body.killSwitch === "boolean" ? body.killSwitch : undefined,
      paused: typeof body.paused === "boolean" ? body.paused : undefined
    },
    "api-server",
    body.reason ?? "Manual API control update",
    defaultConfig
  );

  // Discord notifications for manual control changes
  const discord = createDiscordNotifier(process.env.DISCORD_WEBHOOK_URL, profileId, "API");
  if (typeof body.killSwitch === "boolean") {
    discord.send(body.killSwitch ? "🔴 **Kill switch activated** via API" : "✅ **Kill switch reset** via API");
  }
  if (typeof body.paused === "boolean" && typeof body.killSwitch !== "boolean") {
    discord.send(body.paused ? "⏸️ **Bot paused** via API" : "▶️ **Bot resumed** via API");
  }

  res.json(control);
});

app.get("/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.write(`event: boot\ndata: ${JSON.stringify({ ts: Date.now(), status: "connected" })}\n\n`);

  const emitSnapshot = async (profileId: string) => {
    try {
      const [summary, control, timeline, activity, alerts] = await Promise.all([
        getPipelineSummary(prisma, profileId),
        getActiveControlState(prisma, profileId, defaultConfig),
        listRecentTimeline(prisma, profileId, 20),
        listRecentActivity(prisma, profileId, 12),
        listRecentAlerts(prisma, profileId, 8)
      ]);

      res.write(`event: summary\ndata: ${JSON.stringify({ ...summary, control, ts: Date.now() })}\n\n`);
      res.write(`event: timeline\ndata: ${JSON.stringify({ count: timeline.length, data: timeline })}\n\n`);
      res.write(`event: activity\ndata: ${JSON.stringify({ count: activity.intents.length, total: activity.total, data: activity.intents })}\n\n`);
      res.write(`event: alerts\ndata: ${JSON.stringify({ count: alerts.length, data: alerts })}\n\n`);
      res.write(`event: ping\ndata: ${JSON.stringify({ ts: Date.now() })}\n\n`);
    } catch (error) {
      res.write(
        `event: error\ndata: ${JSON.stringify({ message: error instanceof Error ? error.message : String(error) })}\n\n`
      );
    }
  };

  const ssePid = getProfileId(req);
  void emitSnapshot(ssePid);
  const interval = setInterval(() => {
    void emitSnapshot(ssePid);
  }, 3000);

  res.on("close", () => {
    clearInterval(interval);
  });
});

app.listen(port, () => {
  console.log(`api-server listening on ${port}`);
});

setInterval(async () => {
  try {
    const [summary, control, botHeartbeatTs] = await Promise.all([
      getPipelineSummary(prisma, defaultProfileId),
      getActiveControlState(prisma, defaultProfileId, defaultConfig),
      getRuntimeMetricNumber(prisma, defaultProfileId, "bot.heartbeat_ts")
    ]);
    console.log("api-server status", {
      ts: Date.now(),
      mode: defaultConfig.mode,
      control,
      botHeartbeatTs,
      summary
    });
  } catch (error) {
    console.log("api-server status", {
      ts: Date.now(),
      mode: defaultConfig.mode,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}, 30000);

process.on("SIGINT", async () => {
  await prisma.$disconnect();
  process.exit(0);
});
