import { buildDefaultConfig, createDiscordNotifier } from "@copybot/core";
import {
  countLeaderEventsWithoutIntent,
  countRecentErrorAlerts,
  countStalePlacedIntents,
  createAlert,
  createDbClient,
  DEFAULT_PROFILE_ID,
  ensureActiveConfigVersion,
  getRuntimeMetric,
  getRuntimeMetricNumber,
  getActiveControlState,
  isLeaderCursorStale,
  setRuntimeControlState
} from "@copybot/db";

const config = buildDefaultConfig();
const profileId = process.env.PROFILE_ID ?? DEFAULT_PROFILE_ID;
const prisma = createDbClient();
const discord = createDiscordNotifier(
  process.env.DISCORD_WEBHOOK_URL,
  profileId,
  process.env.BOT_MODE ?? "PAPER"
);
const cooldowns = new Map<string, number>();
let lastStatusSnapshot: Record<string, unknown> = {
  killSwitch: config.safety.killSwitch,
  paused: config.safety.paused,
  missingIntents: 0,
  cursorStale: false,
  heartbeatStale: false,
  stalePlaced: 0,
  errorCount: 0,
  feedError: false
};

function fireAndForget(task: Promise<unknown>, label: string): void {
  task.catch((error) => {
    console.error("guardian-worker async task failed", {
      label,
      error: error instanceof Error ? error.message : String(error)
    });
  });
}

function shouldEmit(code: string, cooldownMs: number): boolean {
  const now = Date.now();
  const last = cooldowns.get(code) ?? 0;
  if (now - last < cooldownMs) {
    return false;
  }
  cooldowns.set(code, now);
  return true;
}

async function runGuardianChecks(): Promise<void> {
  const [missingIntents, cursorStale, stalePlaced, errorCount, botHeartbeatTs, feedLastError, feedEventsSeen] = await Promise.all([
    countLeaderEventsWithoutIntent(prisma, profileId, 8),
    isLeaderCursorStale(prisma, profileId, config.leader.wallet, config.safety.wsStaleSeconds),
    countStalePlacedIntents(prisma, profileId, config.execution.maxChaseSeconds),
    countRecentErrorAlerts(prisma, profileId, config.safety.errorStorm.windowSeconds),
    getRuntimeMetricNumber(prisma, profileId, "bot.heartbeat_ts"),
    getRuntimeMetric(prisma, profileId, "bot.feed.last_error"),
    getRuntimeMetricNumber(prisma, profileId, "bot.feed.events_seen")
  ]);
  const control = await getActiveControlState(prisma, profileId, config);
  const heartbeatAgeMs = botHeartbeatTs ? Date.now() - botHeartbeatTs : Number.POSITIVE_INFINITY;
  const heartbeatStale = heartbeatAgeMs > config.safety.botHeartbeatStaleSeconds * 1000;
  const feedError = (feedLastError?.value ?? "").trim();
  const hasSeenLeaderEvents = (feedEventsSeen ?? 0) > 0;
  const actionableCursorStale = cursorStale && hasSeenLeaderEvents;

  if (missingIntents > 0 && shouldEmit("LEADER_EVENT_DIVERGENCE", 60_000)) {
    // Alert only — many leader events are legitimately filtered (budget, market filters, etc.)
    // and will never produce a copy intent. Pausing here causes false positives.
    await createAlert(prisma, profileId, "WARN", "LEADER_EVENT_DIVERGENCE", "Leader events missing copy intents", {
      missingIntents
    });
  }

  if (cursorStale && config.leader.feedMode !== "DATA_API_POLL" && shouldEmit("MARKET_WS_STALE", 10_000)) {
    await createAlert(prisma, profileId, "WARN", "MARKET_WS_STALE", "Leader cursor appears stale", {
      wsStaleSeconds: config.safety.wsStaleSeconds,
      hasSeenLeaderEvents
    });
  }

  if (heartbeatStale && shouldEmit("BOT_HEARTBEAT_STALE", 10_000)) {
    await createAlert(prisma, profileId, "ERROR", "BOT_HEARTBEAT_STALE", "Bot heartbeat is stale", {
      botHeartbeatStaleSeconds: config.safety.botHeartbeatStaleSeconds,
      heartbeatAgeMs
    });
    if (!control.paused) {
      await setRuntimeControlState(prisma, profileId, { paused: true }, "guardian-worker", "Bot heartbeat stale", config);
      discord.send(`⏸️ **Bot paused** — heartbeat stale (${Math.round(heartbeatAgeMs / 1000)}s since last beat)`);
      control.paused = true;
    }
  }

  if (feedError && shouldEmit("LEADER_FEED_ERROR", 15_000)) {
    await createAlert(prisma, profileId, "WARN", "LEADER_FEED_ERROR", "Leader feed reported errors", {
      feedError
    });
  }

  if (stalePlaced > 0 && shouldEmit("INTENT_STUCK", 60_000)) {
    await createAlert(prisma, profileId, "WARN", "INTENT_STUCK", "Placed intents exceeded chase threshold", {
      stalePlaced,
      maxChaseSeconds: config.execution.maxChaseSeconds
    });
    // NOTE: Do NOT pause here — stuck orders will fill eventually or be resolved by market
    // expiry. Pausing the bot for a single stuck order and never auto-resuming causes a
    // restart→re-detect→re-pause loop that stops all new trades indefinitely.
    discord.send(`⚠️ **Stuck intent** — ${stalePlaced} order(s) exceeded chase threshold (${config.execution.maxChaseSeconds}s). Bot continues trading.`);
  }

  if (
    config.safety.pauseOnErrorStorm &&
    errorCount >= config.safety.errorStorm.maxErrors &&
    shouldEmit("ERROR_STORM", 15_000)
  ) {
    await createAlert(prisma, profileId, "ERROR", "ERROR_STORM", "Error storm threshold exceeded", {
      count: errorCount,
      threshold: config.safety.errorStorm.maxErrors,
      windowSeconds: config.safety.errorStorm.windowSeconds
    });
    if (!control.killSwitch || !control.paused) {
      await setRuntimeControlState(
        prisma,
        profileId,
        { killSwitch: true, paused: true },
        "guardian-worker",
        "Error storm threshold exceeded",
        config
      );
      discord.send(`🔴 **Kill switch activated** — error storm: ${errorCount} errors in ${config.safety.errorStorm.windowSeconds}s`);
      control.killSwitch = true;
      control.paused = true;
    }
  }

  lastStatusSnapshot = {
    killSwitch: control.killSwitch,
    paused: control.paused,
    missingIntents,
    cursorStale,
    actionableCursorStale,
    hasSeenLeaderEvents,
    heartbeatStale,
    stalePlaced,
    errorCount,
    feedError: Boolean(feedError)
  };
}

console.log("guardian-worker starting", {
  pauseOnErrorStorm: config.safety.pauseOnErrorStorm,
  wsStaleSeconds: config.safety.wsStaleSeconds
});

fireAndForget(ensureActiveConfigVersion(prisma, profileId, config), "ensureActiveConfigVersion");

setInterval(() => {
  fireAndForget(runGuardianChecks(), "runGuardianChecks");
}, 5000);

setInterval(() => {
  console.log("guardian-worker status", {
    ts: Date.now(),
    mode: config.mode,
    leader: config.leader.wallet,
    ...lastStatusSnapshot
  });
}, 30000);

process.on("SIGINT", async () => {
  await prisma.$disconnect();
  process.exit(0);
});
