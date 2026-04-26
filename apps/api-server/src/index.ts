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
  setRuntimeControlState,
  setRuntimeMetric
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

app.get("/config/active", async (req, res) => {
  const profileId = getProfileId(req);
  const activeConfig = await ensureActiveConfigVersion(prisma, profileId, defaultConfig);
  res.json(activeConfig);
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

// ── Sport detection helper (mirrors bot-worker-v2 logic) ─────────────────────
function detectSport(slug: string): string | null {
  if (!slug) return null;
  if (slug.startsWith("atp-") || slug.startsWith("wta-") || slug.startsWith("tennis-")) return "tennis";
  if (slug.startsWith("mlb-")) return "mlb";
  if (slug.startsWith("nba-")) return "nba";
  if (slug.startsWith("nhl-")) return "nhl";
  if (slug.startsWith("nfl-")) return "nfl";
  if (slug.startsWith("ncaa-") || slug.startsWith("college-basketball-")) return "ncaa_bb";
  if (slug.startsWith("mls-") || slug.startsWith("epl-") || slug.startsWith("ucl-") || slug.startsWith("soccer-")) return "soccer";
  return null;
}

// ── GET /analytics/sport-stats — per-sport win rate + P&L for a profile ──────
// Returns stats computed from fills + positions. Use ?days=30 to change window.
app.get("/analytics/sport-stats", async (req, res) => {
  const profileId = getProfileId(req);
  const days = Math.min(365, Math.max(1, Number(req.query.days ?? 30)));
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  // Step 1: get all BUY intents with leaderEventId in the window
  const buyIntents = await prisma.copyIntent.findMany({
    where: { profileId, side: "BUY", status: { in: ["FILLED", "PARTIALLY_FILLED_OK"] }, ts: { gte: since } },
    select: { id: true, tokenId: true, leaderEventId: true }
  });

  if (buyIntents.length === 0) {
    res.json({ sports: [] });
    return;
  }

  // Step 2: get slugs from leader events
  const leaderEventIds = [...new Set(buyIntents.map((i) => i.leaderEventId).filter(Boolean))];
  const leaderEvents = await prisma.leaderEvent.findMany({
    where: { id: { in: leaderEventIds } },
    select: { id: true, tokenId: true, rawJson: true }
  });
  const slugByLeaderEventId = new Map<string, string>();
  for (const ev of leaderEvents) {
    try {
      const raw = JSON.parse(ev.rawJson) as { slug?: string; eventSlug?: string };
      const slug = (raw.slug ?? raw.eventSlug ?? "").toLowerCase();
      if (slug) slugByLeaderEventId.set(ev.id, slug);
    } catch { /* ignore */ }
  }

  // Step 3: map tokenId → sport
  const sportByTokenId = new Map<string, string>();
  for (const intent of buyIntents) {
    const slug = slugByLeaderEventId.get(intent.leaderEventId) ?? "";
    const sport = detectSport(slug);
    if (sport && !sportByTokenId.has(intent.tokenId)) {
      sportByTokenId.set(intent.tokenId, sport);
    }
  }

  // Step 4: get fills for these intents (via orders)
  const intentIds = buyIntents.map((i) => i.id);
  const orders = await prisma.order.findMany({
    where: { profileId, intentId: { in: intentIds } },
    select: { id: true, intentId: true, side: true }
  });
  const orderToIntent = new Map(orders.map((o) => [o.id, o.intentId]));
  const intentToTokenId = new Map(buyIntents.map((i) => [i.id, i.tokenId]));

  const orderIds = orders.map((o) => o.id);
  const allFills = await prisma.fill.findMany({
    where: { profileId, orderId: { in: orderIds } },
    select: { orderId: true, price: true, size: true }
  });

  // Step 5: also get SELL fills for these tokens (to compute P&L)
  const uniqueTokenIds = [...new Set(buyIntents.map((i) => i.tokenId))];
  const sellIntents = await prisma.copyIntent.findMany({
    where: { profileId, side: "SELL", tokenId: { in: uniqueTokenIds } },
    select: { id: true, tokenId: true }
  });
  const sellIntentIds = sellIntents.map((i) => i.id);
  const sellOrders = await prisma.order.findMany({
    where: { profileId, intentId: { in: sellIntentIds } },
    select: { id: true, intentId: true }
  });
  const sellOrderIds = sellOrders.map((o) => o.id);
  const sellFills = await prisma.fill.findMany({
    where: { profileId, orderId: { in: sellOrderIds } },
    select: { orderId: true, price: true, size: true }
  });
  const sellIntentToTokenId = new Map(sellIntents.map((i) => [i.id, i.tokenId]));
  const sellOrderToIntent = new Map(sellOrders.map((o) => [o.id, o.intentId]));

  // Step 6: aggregate per tokenId
  type TokenStats = { buyCost: number; buyShares: number; sellRevenue: number; sellShares: number };
  const byToken = new Map<string, TokenStats>();

  for (const fill of allFills) {
    const intentId = orderToIntent.get(fill.orderId);
    if (!intentId) continue;
    const tokenId = intentToTokenId.get(intentId);
    if (!tokenId) continue;
    const st = byToken.get(tokenId) ?? { buyCost: 0, buyShares: 0, sellRevenue: 0, sellShares: 0 };
    st.buyCost += fill.size * fill.price;
    st.buyShares += fill.size;
    byToken.set(tokenId, st);
  }

  for (const fill of sellFills) {
    const intentId = sellOrderToIntent.get(fill.orderId);
    if (!intentId) continue;
    const tokenId = sellIntentToTokenId.get(intentId);
    if (!tokenId) continue;
    const st = byToken.get(tokenId) ?? { buyCost: 0, buyShares: 0, sellRevenue: 0, sellShares: 0 };
    st.sellRevenue += fill.size * fill.price;
    st.sellShares += fill.size;
    byToken.set(tokenId, st);
  }

  // Step 7: get position states
  const positions = await prisma.position.findMany({
    where: { profileId, tokenId: { in: uniqueTokenIds } },
    select: { tokenId: true, size: true, avgPrice: true }
  });
  const positionByToken = new Map(positions.map((p) => [p.tokenId, p]));

  // Step 8: aggregate per sport
  type SportStats = { trades: number; wins: number; losses: number; open: number; pnl: number; totalCost: number };
  const bySport = new Map<string, SportStats>();

  for (const [tokenId, stats] of byToken) {
    const sport = sportByTokenId.get(tokenId) ?? "other";
    const pos = positionByToken.get(tokenId);
    const isClosed = !pos || pos.size < 0.001;
    const hasSellFill = stats.sellShares > 0;
    const sp = bySport.get(sport) ?? { trades: 0, wins: 0, losses: 0, open: 0, pnl: 0, totalCost: 0 };
    sp.trades += 1;
    sp.totalCost += stats.buyCost;
    if (isClosed) {
      if (hasSellFill) {
        // Closed via SELL fill (synthetic close or real sell)
        const pnl = stats.sellRevenue - stats.buyCost;
        sp.pnl += pnl;
        if (pnl >= 0) sp.wins += 1; else sp.losses += 1;
      } else {
        // Closed without sell fill = market resolved at 0 (full loss)
        sp.pnl -= stats.buyCost;
        sp.losses += 1;
      }
    } else {
      // Open position: mark to avgPrice (neutral)
      sp.open += 1;
      const markPnl = stats.buyCost > 0 ? (pos.avgPrice - (stats.buyCost / Math.max(stats.buyShares, 0.0001))) * stats.buyShares : 0;
      sp.pnl += markPnl;
    }
    bySport.set(sport, sp);
  }

  const sports = [...bySport.entries()]
    .map(([sport, s]) => ({
      sport,
      trades: s.trades,
      wins: s.wins,
      losses: s.losses,
      open: s.open,
      winRate: s.trades > 0 ? Number((s.wins / (s.wins + s.losses || 1)).toFixed(4)) : 0,
      pnl: Number(s.pnl.toFixed(4)),
      totalCost: Number(s.totalCost.toFixed(4))
    }))
    .sort((a, b) => b.trades - a.trades);

  res.json({ sports, days });
});

// ── GET /config/sport-filters — current filter settings for a profile ─────────
app.get("/config/sport-filters", async (req, res) => {
  const profileId = getProfileId(req);
  const [activeConfig, overrideMetric] = await Promise.all([
    ensureActiveConfigVersion(prisma, profileId, defaultConfig),
    getRuntimeMetric(prisma, profileId, "bot.sport_filter_overrides")
  ]);

  let dashboardOverrides: Record<string, unknown> = {};
  if (overrideMetric?.value) {
    try { dashboardOverrides = JSON.parse(overrideMetric.value) as Record<string, unknown>; } catch { /* ignore */ }
  }

  res.json({
    global: {
      min: activeConfig.filters.minPrice,
      max: activeConfig.filters.maxPrice
    },
    sports: activeConfig.filters.sportPriceFilters,
    blockedSlugPrefixes: activeConfig.filters.blockedSlugPrefixes,
    blockedTitleKeywords: activeConfig.filters.blockedTitleKeywords,
    dashboardOverrides
  });
});

// ── POST /config/sport-filters — save filter overrides (applied on bot restart) 
app.post("/config/sport-filters", async (req, res) => {
  const profileId = getProfileId(req);
  const body = (req.body ?? {}) as {
    global?: { min?: number; max?: number };
    sports?: Record<string, { min: number; max: number }>;
    blockedSlugPrefixes?: string[];
    blockedTitleKeywords?: string[];
  };

  // Basic validation
  const global = body.global;
  if (global) {
    if (typeof global.min === "number" && (global.min < 0 || global.min > 1)) {
      res.status(400).json({ error: "global.min must be between 0 and 1" });
      return;
    }
    if (typeof global.max === "number" && (global.max < 0 || global.max > 1)) {
      res.status(400).json({ error: "global.max must be between 0 and 1" });
      return;
    }
  }

  if (body.sports) {
    for (const [sport, filter] of Object.entries(body.sports)) {
      if (typeof filter.min !== "number" || filter.min < 0 || filter.min > 1 ||
          typeof filter.max !== "number" || filter.max < 0 || filter.max > 1) {
        res.status(400).json({ error: `Invalid filter for sport "${sport}": min/max must be 0-1` });
        return;
      }
    }
  }

  const overrides = {
    ...(global && { global }),
    ...(body.sports && { sports: body.sports }),
    ...(Array.isArray(body.blockedSlugPrefixes) && { blockedSlugPrefixes: body.blockedSlugPrefixes }),
    ...(Array.isArray(body.blockedTitleKeywords) && { blockedTitleKeywords: body.blockedTitleKeywords })
  };

  await setRuntimeMetric(prisma, profileId, "bot.sport_filter_overrides", JSON.stringify(overrides));

  res.json({ saved: true, restartRequired: true, profileId });
});

// ── GET /analytics/sport-stats/simulate — impact of proposed filters on recent trades
app.get("/analytics/sport-stats/simulate", async (req, res) => {
  const profileId = getProfileId(req);
  const days = Math.min(90, Math.max(1, Number(req.query.days ?? 30)));
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  // Parse proposed filters from query params
  // e.g. ?sports=tennis:0.70:0.88,mlb:0.60:0.80&globalMin=0.60&globalMax=0.88
  const globalMin = req.query.globalMin ? Number(req.query.globalMin) : undefined;
  const globalMax = req.query.globalMax ? Number(req.query.globalMax) : undefined;
  const sportsRaw = String(req.query.sports ?? "");
  const proposedSports: Record<string, { min: number; max: number }> = {};
  for (const entry of sportsRaw.split(",")) {
    const parts = entry.split(":");
    if (parts.length === 3) {
      const sport = parts[0].trim().toLowerCase();
      const min = Number(parts[1]);
      const max = Number(parts[2]);
      if (sport && Number.isFinite(min) && Number.isFinite(max)) {
        proposedSports[sport] = { min, max };
      }
    }
  }

  // Get leader BUY events in the window
  const leaderEvents = await prisma.leaderEvent.findMany({
    where: { profileId, side: "BUY", ts: { gte: since } },
    select: { id: true, tokenId: true, price: true, rawJson: true }
  });

  let wouldTrade = 0;
  let wouldBlock = 0;

  for (const ev of leaderEvents) {
    let slug = "";
    try {
      const raw = JSON.parse(ev.rawJson) as { slug?: string; eventSlug?: string };
      slug = (raw.slug ?? raw.eventSlug ?? "").toLowerCase();
    } catch { /* ignore */ }

    const sport = detectSport(slug);
    const gMin = globalMin ?? 0;
    const gMax = globalMax ?? 1;

    if (ev.price < gMin || ev.price > gMax) { wouldBlock++; continue; }

    if (sport && proposedSports[sport]) {
      const sf = proposedSports[sport];
      if (ev.price < sf.min || ev.price > sf.max) { wouldBlock++; continue; }
    }

    wouldTrade++;
  }

  res.json({
    days,
    total: leaderEvents.length,
    wouldTrade,
    wouldBlock,
    blockRate: leaderEvents.length > 0 ? Number((wouldBlock / leaderEvents.length).toFixed(4)) : 0
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
