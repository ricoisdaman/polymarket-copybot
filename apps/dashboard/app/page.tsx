export const dynamic = "force-dynamic";

import type { CSSProperties } from "react";
import PortfolioCharts, { type PieSlice, type PnlPoint } from "./components/PortfolioCharts";
import ProfileSwitcher from "./components/ProfileSwitcher";
import ResumeButton from "./components/ResumeButton";
import FiltersPanel from "./components/FiltersPanel";

type SummaryResponse = {
  leaderEvents: number;
  intents: number;
  openPositions: number;
  alerts: number;
  cashBalance: number;
  drawdownUSDC: number;
  startingBalanceUSDC: number;
  liveStartedAt: number | null;
  mode: "PAPER" | "LIVE";
  control: {
    killSwitch: boolean;
    paused: boolean;
  };
  ts: number;
  /** USDC value of resolved-YES positions not yet redeemed on Polymarket */
  unredeemedUSDC: number;
  /** True portfolio value = cash + all position values (resolution-aware) */
  portfolioValue: number;
};

type RecentIntent = {
  id: string;
  ts: string;
  tokenId: string;
  side: "BUY" | "SELL";
  status: string;
  reason: string | null;
  leaderSize: number;
  desiredSize: number;
  desiredNotional: number;
  marketTitle: string | null;
};

type ActivityResponse = {
  count: number;
  total: number;
  data: RecentIntent[];
};

type LeaderTradeRow = {
  id: string;
  ts: number;
  tokenId: string;
  conditionId: string;
  side: string;
  price: number;
  size: number;
  usdcSize: number;
  title: string;
  slug: string;
  outcome: string;
};

type LeaderActivityResponse = {
  count: number;
  data: LeaderTradeRow[];
  error?: string;
};

type AlertItem = {
  id: string;
  ts: string;
  severity: "INFO" | "WARN" | "ERROR";
  code: string;
  message: string;
};

type AlertsResponse = {
  count: number;
  data: AlertItem[];
};

type TimelineItem = {
  id: string;
  kind: "intent" | "order" | "fill";
  ts: string;
  tokenId?: string;
  side?: string;
  status?: string;
  price?: number;
  size?: number;
  desiredNotional?: number;
};

type TimelineResponse = {
  count: number;
  data: TimelineItem[];
};

type PositionSummaryRow = {
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
  /** 0 = lost, 1 = won, undefined = unknown/still live */
  resolutionValue?: number;
};

type PositionsSummaryResponse = {
  open: PositionSummaryRow[];
  closed: PositionSummaryRow[];
};

type ActiveConfigResponse = {
  budget: {
    maxNotionalPerMarketUSDC: number;
    maxOpenMarkets: number;
    maxDailyNotionalUSDC: number;
    maxDailyDrawdownUSDC: number;
    dailyResetHourUtc: number;
  };
  filters: {
    minPrice: number;
    maxPrice: number;
    blockedTitleKeywords?: string[];
  };
};

type RuntimeMetricRow = {
  key: string;
  value: string;
  updatedAt: string;
};

type RuntimeMetricsResponse = {
  count: number;
  data: RuntimeMetricRow[];
};

const apiBaseUrl = process.env.API_BASE_URL ?? "http://localhost:4000";

async function fetchJson<T>(path: string): Promise<T | null> {
  try {
    const response = await fetch(`${apiBaseUrl}${path}`, { cache: "no-store" });
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

function buildUrl(path: string, profileId: string, extra?: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams();
  params.set("profileId", profileId);
  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      if (v !== undefined) params.set(k, String(v));
    }
  }
  const sep = path.includes("?") ? "&" : "?";
  return `${path}${sep}${params.toString()}`;
}

function buildChartData(
  summary: SummaryResponse | null,
  positions: PositionsSummaryResponse | null
): { pieData: PieSlice[]; pnlData: PnlPoint[] } {
  // Pie: available cash + unclaimed winnings + each open position's current value
  const cash = summary?.cashBalance ?? 0;
  const unredeemed = summary?.unredeemedUSDC ?? 0;
  const open = positions?.open ?? [];
  const pieData: PieSlice[] = [
    { name: "Cash", value: cash },
    ...(unredeemed > 0 ? [{ name: "Unclaimed Winnings", value: unredeemed }] : []),
    ...open.map((p) => ({
      name: p.marketTitle.length > 28 ? p.marketTitle.slice(0, 26) + "\u2026" : p.marketTitle,
      value: p.currentValue,
    })),
  ].filter((d) => d.value > 0);

  // P&L: cumulative from closed positions sorted by updatedAt
  const closed = [...(positions?.closed ?? [])].sort(
    (a, b) => new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime()
  );
  let cumulative = 0;
  const pnlData: PnlPoint[] = closed.map((p) => {
    cumulative += p.pnl;
    return {
      time: new Date(p.updatedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" }),
      pnl: Math.round(cumulative * 100) / 100,
    };
  });

  return { pieData, pnlData };
}

export default async function HomePage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const params = await searchParams;
  const profileId = params.profileId ?? "default";
  const intentPage = Math.max(1, Number(params.intentPage ?? 1) || 1);
  const intentPageSize = 20;
  const intentOffset = (intentPage - 1) * intentPageSize;

  // Fetch summary first so we know liveStartedAt and bot mode before other calls
  const summary = await fetchJson<SummaryResponse>(buildUrl("/status/summary", profileId));

  // modeFilter: URL param overrides; default to bot's current mode
  const defaultModeFilter = summary?.mode ?? "ALL";
  const modeFilter = (params.modeFilter ?? defaultModeFilter) as "LIVE" | "PAPER" | "ALL";
  // When LIVE mode but live has not started yet (liveStartedAt = null), use Date.now() as
  // the anchor so that no stale paper data bleeds through until the first real live session.
  const since = modeFilter === "LIVE" ? (summary?.liveStartedAt ?? Date.now()) : undefined;
  const activityMode = modeFilter === "ALL" ? undefined : modeFilter;

  const [positions, activity, alerts, timeline, leaderActivity, activeConfig, runtimeMetrics] = await Promise.all([
    fetchJson<PositionsSummaryResponse>(buildUrl("/positions/summary", profileId, { since })),
    fetchJson<ActivityResponse>(buildUrl(`/activity/recent?limit=${intentPageSize}&offset=${intentOffset}`, profileId, { mode: activityMode })),
    fetchJson<AlertsResponse>(buildUrl("/alerts/recent?limit=8", profileId, { since })),
    fetchJson<TimelineResponse>(buildUrl("/timeline/recent?limit=16", profileId, { since })),
    fetchJson<LeaderActivityResponse>(buildUrl("/leader/activity?limit=50", profileId)),
    fetchJson<ActiveConfigResponse>(buildUrl("/config/active", profileId)),
    fetchJson<RuntimeMetricsResponse>(buildUrl("/metrics/runtime?prefix=bot.", profileId)),
  ]);

  const { pieData, pnlData } = buildChartData(summary, positions);
  const metrics = new Map((runtimeMetrics?.data ?? []).map((m) => [m.key, m.value]));
  const dailyUsed = Number(metrics.get("bot.daily_notional_usdc") ?? 0);
  const dailyLimit = activeConfig?.budget.maxDailyNotionalUSDC ?? 0;
  const drawdownUsed = Math.max(0, summary?.drawdownUSDC ?? 0);
  const drawdownLimit = activeConfig?.budget.maxDailyDrawdownUSDC ?? 0;
  const openMarketsUsed = positions?.open.length ?? 0;
  const openMarketsLimit = activeConfig?.budget.maxOpenMarkets ?? 0;
  const maxOpenPositionCost = positions?.open.reduce((mx, p) => Math.max(mx, p.amount), 0) ?? 0;
  const perMarketLimit = activeConfig?.budget.maxNotionalPerMarketUSDC ?? 0;
  const blockedKeywords = activeConfig?.filters.blockedTitleKeywords ?? [];

  return (
    <main className="container dashboard-shell py-4">
      {/* ── Kill Switch / Paused Alert Banners ─────────────── */}
      {summary?.control.paused && !summary.control.killSwitch && (
        <div
          className="mb-3 px-3 py-2 d-flex align-items-center justify-content-between gap-2"
          style={{
            background: "rgba(255,149,0,0.10)",
            border: "1px solid #ff9500",
            borderRadius: "4px",
            color: "#ff9500",
            fontSize: "0.82rem",
            letterSpacing: "0.07em",
          }}
        >
          <span>
            <span style={{ fontWeight: 700, fontSize: "1rem" }}>⏸ </span>
            <strong>BOT PAUSED</strong> — new copy intents are blocked. Use the resume button below or restart the bot-worker to auto-clear.
          </span>
          <ResumeButton profileId={profileId} />
        </div>
      )}
      {summary?.control.killSwitch && (
        <div
          className="mb-3 px-3 py-2 d-flex align-items-center gap-2"
          style={{
            background: "rgba(255,0,60,0.12)",
            border: "1px solid var(--hk-danger)",
            borderRadius: "4px",
            color: "var(--hk-danger)",
            fontSize: "0.82rem",
            letterSpacing: "0.07em",
          }}
        >
          <span style={{ fontWeight: 700, fontSize: "1rem" }}>⚠</span>
          <span>
            <strong>KILL SWITCH ACTIVE</strong> — all trade execution is blocked. Reset via{" "}
            <code style={{ fontSize: "0.76rem" }}>scripts/reset-runtime-control.mjs</code> then restart workers.
          </span>
        </div>
      )}

      {/* ── Header ───────────────────────────────────────────── */}
      <div className="d-flex flex-wrap align-items-center justify-content-between gap-2 mb-4">
        <div>
          <h1 className="h3 mb-0 hk-title">COPYBOT</h1>
          <p className="hk-subtitle mb-0">// polymarket copy-trade terminal — {summary?.mode?.toLowerCase() ?? "paper"} mode</p>
        </div>
        <div className="d-flex align-items-center gap-2 flex-wrap">
          <ProfileSwitcher currentProfile={profileId} />
          <a href="/compare" className="btn btn-sm btn-outline-secondary" style={{ fontSize: "0.74rem", letterSpacing: "0.06em" }}>COMPARE</a>
          {/* Mode filter tabs */}
          {(["ALL", "LIVE", "PAPER"] as const).map((m) => {
            const q = new URLSearchParams();
            if (profileId !== "default") q.set("profileId", profileId);
            if (m !== defaultModeFilter) q.set("modeFilter", m);
            const href = q.toString() ? `/?${q.toString()}` : "/";
            const active = modeFilter === m;
            return (
              <a key={m} href={href} className="btn btn-sm" style={{
                fontSize: "0.72rem", letterSpacing: "0.07em", padding: "2px 10px",
                background: active ? "var(--hk-accent)" : "rgba(255,255,255,0.06)",
                color: active ? "#000" : "var(--hk-text-dim)",
                border: active ? "1px solid var(--hk-accent)" : "1px solid rgba(255,255,255,0.12)",
                borderRadius: 3, fontWeight: active ? 700 : 400
              }}>{m}</a>
            );
          })}
          <span className={`badge ${getRuntimeBadgeClass(summary)}`}>{getRuntimeStatusLabel(summary)}</span>
        </div>
      </div>

      {/* ── KPI row ──────────────────────────────────────────── */}
      <section className="row g-3 mb-4">
        <div className="col-6 col-md-4 col-xl-2">
          <StatCard label="Mode" value={summary?.mode ?? "OFFLINE"} />
        </div>
        <div className="col-6 col-md-4 col-xl-2">
          {(() => {
            const portfolio = summary?.portfolioValue ?? summary?.cashBalance ?? 0;
            const unredeemed = summary?.unredeemedUSDC ?? 0;
            const subVal = unredeemed > 0 ? `Cash: ${formatUsd(summary?.cashBalance ?? 0)} + Unclaimed: ${formatUsd(unredeemed)}` : `Cash: ${formatUsd(summary?.cashBalance ?? 0)}`;
            return (
              <StatCard
                label="Portfolio Value"
                value={formatUsd(portfolio)}
                subValue={subVal}
              />
            );
          })()}
        </div>
        <div className="col-6 col-md-4 col-xl-2">
          {(() => {
            // True lifetime P&L = portfolio value (cash + resolution-aware position
            // values including unclaimed YES winnings) minus the original starting capital.
            const portfolio = summary?.portfolioValue ?? summary?.cashBalance ?? 0;
            const startingBalance = summary?.startingBalanceUSDC ?? 50;
            const totalPnl = portfolio - startingBalance;
            const openUnrealized = positions?.open.reduce((s, r) => s + r.pnl, 0) ?? 0;
            const roiPct = startingBalance > 0 ? (totalPnl / startingBalance) * 100 : 0;
            return (
              <StatCard
                label="Portfolio P&L"
                value={formatSignedUsd(totalPnl)}
                subValue={`ROI: ${roiPct >= 0 ? "+" : ""}${roiPct.toFixed(1)}% | Unreal: ${formatSignedUsd(openUnrealized)}`}
                valueColor={totalPnl >= 0 ? "#00e855" : "var(--hk-danger)"}
              />
            );
          })()}
        </div>
        <div className="col-6 col-md-4 col-xl-2">
          <StatCard
            label="Copy Intents"
            value={String(summary?.intents ?? 0)}
            subValue={`Leader Events: ${summary?.leaderEvents ?? 0}`}
          />
        </div>
        <div className="col-6 col-md-4 col-xl-2">
          <StatCard label="Open Positions" value={String(positions?.open.length ?? 0)} />
        </div>
        <div className="col-6 col-md-4 col-xl-2">
          <StatCard label="Closed Positions" value={String(positions?.closed.length ?? 0)} />
        </div>
      </section>

      <section className="hk-card shadow-sm mb-4">
        <div className="hk-card-header d-flex align-items-center justify-content-between">
          <span>Filters &amp; Limit Health</span>
          <span style={{ fontSize: "0.68rem", color: "var(--hk-text-dim)", letterSpacing: "0.05em" }}>
            reset: {activeConfig ? `${String(activeConfig.budget.dailyResetHourUtc).padStart(2, "0")}:00 UTC` : "—"}
          </span>
        </div>
        <div className="row g-3 p-3">
          <div className="col-12 col-lg-6">
            <div style={{ fontSize: "0.74rem", color: "var(--hk-text-dim)", letterSpacing: "0.06em", marginBottom: 6 }}>ENABLED FILTERS</div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
              <span style={getTinyPillStyle("info")}>Price: {(activeConfig?.filters.minPrice ?? 0).toFixed(2)} - {(activeConfig?.filters.maxPrice ?? 1).toFixed(2)}</span>
              <span style={getTinyPillStyle(blockedKeywords.length > 0 ? "warn" : "ok")}>Keywords: {blockedKeywords.length}</span>
              <span style={getTinyPillStyle("ok")}>Mode: {summary?.mode ?? "OFFLINE"}</span>
            </div>
            {blockedKeywords.length > 0 && (
              <div style={{ color: "var(--hk-text-dim)", fontSize: "0.72rem" }}>
                {blockedKeywords.slice(0, 6).join(", ")}
                {blockedKeywords.length > 6 ? " ..." : ""}
              </div>
            )}
          </div>
          <div className="col-12 col-lg-6">
            <LimitMeter
              label={`Trading-Day Notional (since ${String(activeConfig?.budget.dailyResetHourUtc ?? 0).padStart(2, "0")}:00 UTC)`}
              used={dailyUsed}
              limit={dailyLimit}
              usedLabel={formatUsd(dailyUsed)}
              limitLabel={formatUsd(dailyLimit)}
            />
            <LimitMeter
              label="Drawdown"
              used={drawdownUsed}
              limit={drawdownLimit}
              usedLabel={formatUsd(drawdownUsed)}
              limitLabel={formatUsd(drawdownLimit)}
            />
            <LimitMeter
              label="Open Markets"
              used={openMarketsUsed}
              limit={openMarketsLimit}
              usedLabel={String(openMarketsUsed)}
              limitLabel={String(openMarketsLimit)}
            />
            <LimitMeter
              label="Largest Open Position"
              used={maxOpenPositionCost}
              limit={perMarketLimit}
              usedLabel={formatUsd(maxOpenPositionCost)}
              limitLabel={formatUsd(perMarketLimit)}
            />
          </div>
        </div>
      </section>

      {/* ── Sport Filter Control Panel ────────────────────────── */}
      <section className="hk-card shadow-sm mb-4">
        <div className="hk-card-header">Sport Filter Panel</div>
        <div className="p-3">
          <FiltersPanel profileId={profileId} apiBaseUrl={apiBaseUrl} />
        </div>
      </section>

      {/* ── Open Positions ───────────────────────────────────── */}
      <section className="hk-card shadow-sm mb-4">
        <div className="hk-card-header">Open Positions</div>
        <div className="table-responsive">
          <table className="table table-sm table-hover mb-0 align-middle">
            <thead>
              <tr>
                <th>Market</th>
                <th className="text-end">Cost Basis</th>
                <th className="text-end">Shares</th>
                <th className="text-end" title="Average price paid per share currently held">Avg Cost/sh</th>
                <th className="text-end">Cur. Price</th>
                <th className="text-end">Cur. Value</th>
                <th className="text-end" title="Unrealized gain/loss on current holding only">Unreal. P&amp;L</th>
                <th>Priced At</th>
              </tr>
            </thead>
            <tbody>
              {positions && positions.open.length > 0 ? (
                positions.open.map((item) => (
                  <tr key={`open-${item.tokenId}`}>
                    <td className="token-cell" title={item.tokenId}>
                      <div style={{ color: "var(--hk-text)", fontWeight: 500 }}>{item.marketTitle}</div>
                      <div className="token-subtext">{item.tokenId}</div>
                    </td>
                    <td className="text-end">{formatUsd(item.amount)}</td>
                    <td className="text-end">{formatNumber(item.shares)}</td>
                    <td className="text-end" style={{ color: "var(--hk-text-dim)" }}>{item.avgBuyPrice.toFixed(4)}</td>
                    <td className="text-end" style={{ color: item.lastPrice >= item.avgBuyPrice ? "#00e855" : "var(--hk-danger)", fontWeight: 600 }}>{item.lastPrice.toFixed(4)}</td>
                    <td className="text-end">{formatUsd(item.currentValue)}</td>
                    <td className={`text-end fw-semibold ${item.pnl >= 0 ? "text-success" : "text-danger"}`}>
                      {formatSignedUsd(item.pnl)}
                    </td>
                    <td style={{ color: "var(--hk-text-dim)" }}>{new Date(item.updatedAt).toLocaleTimeString()}</td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={8} className="py-3 text-center" style={{ color: "var(--hk-text-dim)" }}>
                    [ no open positions ]
                  </td>
                </tr>
              )}
            </tbody>
            {positions && positions.open.length > 0 && (
              <tfoot className="table-totals">
                <tr>
                  <td><span style={{ color: "var(--hk-text-dim)", fontSize: "0.7rem", letterSpacing: "0.08em" }}>TOTAL ({positions.open.length})</span></td>
                  <td className="text-end">{formatUsd(positions.open.reduce((s, r) => s + r.amount, 0))}</td>
                  <td className="text-end">{formatNumber(positions.open.reduce((s, r) => s + r.shares, 0))}</td>
                  <td />
                  <td />
                  <td className="text-end">{formatUsd(positions.open.reduce((s, r) => s + r.currentValue, 0))}</td>
                  <td className={`text-end fw-semibold ${positions.open.reduce((s, r) => s + r.pnl, 0) >= 0 ? "text-success" : "text-danger"}`}>
                    {formatSignedUsd(positions.open.reduce((s, r) => s + r.pnl, 0))}
                  </td>
                  <td />
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </section>

      {/* ── Charts ───────────────────────────────────────────── */}
      <section className="mb-4">
        <PortfolioCharts pieData={pieData} pnlData={pnlData} />
      </section>

      {/* ── Closed Positions ─────────────────────────────────── */}
      <section className="hk-card shadow-sm mb-4">
        <div className="hk-card-header d-flex align-items-center justify-content-between">
          <span>Closed Positions</span>
          <span style={{ fontSize: "0.68rem", fontWeight: 400, color: "var(--hk-text-dim)", letterSpacing: "0.04em" }}>
            ✓ = won (on-chain claim)  ✗ = lost  … = resolving (page will update)   accurate total: Portfolio P&amp;L card ↑
          </span>
        </div>
        <div className="table-responsive">
          <table className="table table-sm table-hover mb-0 align-middle">
            <thead>
              <tr>
                <th>Market</th>
                <th>Status</th>
                <th className="text-end">Total Spent</th>
                <th className="text-end">Shares</th>
                <th className="text-end" title="Weighted average buy price across all fills">Avg Buy</th>
                <th className="text-end">Sell Price</th>
                <th className="text-end">Final Value</th>
                <th className="text-end" title="WIN (✓) = shares × 1.00 − cost. LOSS (✗) = −cost. Resolving… = market not yet settled.">P&amp;L</th>
                <th>Closed</th>
              </tr>
            </thead>
            <tbody>
              {positions && positions.closed.length > 0 ? (
                positions.closed.map((item) => {
                  // Determine outcome for on-chain resolved positions (no SELL fill, currentValue=0)
                  const isOnChainResolved = item.currentValue === 0;
                  const isWin  = isOnChainResolved && item.resolutionValue === 1;
                  const isLoss = isOnChainResolved && item.resolutionValue === 0;
                  return (
                    <tr key={`closed-${item.tokenId}`}>
                      <td className="token-cell" title={item.tokenId}>
                        <div style={{ color: "var(--hk-text)", fontWeight: 500 }}>{item.marketTitle}</div>
                        <div className="token-subtext">{item.tokenId}</div>
                      </td>
                      <td>
                        <span style={getMarketStatusStyle(item.marketStatus)}>{item.marketStatus}</span>
                      </td>
                      <td className="text-end">{formatUsd(item.amount)}</td>
                      <td className="text-end">{formatNumber(item.shares)}</td>
                      <td className="text-end" style={{ color: "var(--hk-text-dim)" }}>{item.avgBuyPrice.toFixed(4)}</td>
                      <td className="text-end" style={{ color: item.currentValue > 0 ? (item.lastPrice >= item.avgBuyPrice ? "#00e855" : "var(--hk-danger)") : "var(--hk-text-dim)", fontWeight: 600 }}>
                        {item.currentValue > 0 ? item.lastPrice.toFixed(4) : isWin ? "1.0000" : isLoss ? "0.0000" : "—"}
                      </td>
                      <td className="text-end">{formatUsd(item.currentValue)}</td>
                      <td className="text-end fw-semibold">
                        {isWin
                          ? <span style={{ color: "#00e855" }}>{formatSignedUsd(item.pnl)} ✓</span>
                          : isLoss
                            ? <span style={{ color: "var(--hk-danger)" }}>{formatSignedUsd(item.pnl)} ✗</span>
                            : isOnChainResolved
                              ? <span style={{ color: "var(--hk-text-dim)", fontSize: "0.74rem" }}>Resolving…</span>
                              : <span className={item.pnl >= 0 ? "text-success" : "text-danger"}>{formatSignedUsd(item.pnl)}</span>
                        }
                      </td>
                      <td style={{ color: "var(--hk-text-dim)" }}>{new Date(item.updatedAt).toLocaleTimeString()}</td>
                    </tr>
                  );
                })
              ) : (
                <tr>
                  <td colSpan={9} className="py-3 text-center" style={{ color: "var(--hk-text-dim)" }}>
                    [ no closed positions yet ]
                  </td>
                </tr>
              )}
            </tbody>
            {positions && positions.closed.length > 0 && (
              <tfoot className="table-totals">
                <tr>
                  <td><span style={{ color: "var(--hk-text-dim)", fontSize: "0.7rem", letterSpacing: "0.08em" }}>TOTAL ({positions.closed.length})</span></td>
                  <td />
                  <td className="text-end">{formatUsd(positions.closed.reduce((s, r) => s + r.amount, 0))}</td>
                  <td className="text-end">{formatNumber(positions.closed.reduce((s, r) => s + r.shares, 0))}</td>
                  <td />
                  <td />
                  <td className="text-end">{formatUsd(positions.closed.reduce((s, r) => s + r.currentValue, 0))}</td>
                  <td style={{ color: "var(--hk-text-dim)", fontSize: "0.72rem" }} className="text-end">see card ↑</td>
                  <td />
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </section>

      {/* ── Leader Activity ──────────────────────────────────── */}
      <section className="hk-card shadow-sm mb-4">
        <div className="hk-card-header d-flex align-items-center justify-content-between">
          <span>Leader Activity</span>
          <span style={{ fontSize: "0.68rem", fontWeight: 400, color: "var(--hk-text-dim)", letterSpacing: "0.05em" }}>
            last 50 trades · live from Polymarket
          </span>
        </div>
        <div className="table-responsive">
          <table className="table table-sm table-striped mb-0 align-middle">
            <thead>
              <tr>
                <th>Time</th>
                <th>Market</th>
                <th>Outcome</th>
                <th>Side</th>
                <th className="text-end">Price</th>
                <th className="text-end">Shares</th>
                <th className="text-end">USDC</th>
              </tr>
            </thead>
            <tbody>
              {leaderActivity && leaderActivity.data.length > 0 ? (
                leaderActivity.data.map((item, idx) => (
                  <tr key={`${item.id}-${item.tokenId}-${idx}`}>
                    <td style={{ color: "var(--hk-text-dim)", fontSize: "0.78rem", whiteSpace: "nowrap" }}>
                      {new Date(item.ts).toLocaleTimeString()}
                    </td>
                    <td className="token-cell">
                      <div style={{ color: "var(--hk-text)", fontWeight: 500 }}>
                        {item.title || (item.slug ? item.slug : item.tokenId.slice(0, 16) + "…")}
                      </div>
                      <div className="token-subtext">{item.tokenId.slice(0, 16)}&hellip;</div>
                    </td>
                    <td style={{ fontSize: "0.78rem", color: "var(--hk-text-dim)" }}>
                      {item.outcome || "—"}
                    </td>
                    <td style={{ color: item.side === "BUY" ? "#00e855" : "var(--hk-danger)", fontWeight: 600, fontSize: "0.78rem" }}>
                      {item.side}
                    </td>
                    <td className="text-end" style={{ fontSize: "0.78rem" }}>{item.price.toFixed(3)}</td>
                    <td className="text-end" style={{ fontSize: "0.78rem" }}>{item.size.toFixed(2)}</td>
                    <td className="text-end" style={{ fontSize: "0.78rem" }}>{formatUsd(item.usdcSize)}</td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={7} className="py-3 text-center" style={{ color: "var(--hk-text-dim)" }}>
                    {leaderActivity?.error ? `Error: ${leaderActivity.error}` : "[ no recent leader trades ]"}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* ── Recent Intents ───────────────────────────────────── */}
      <section className="hk-card shadow-sm mb-4">
        {(() => {
          const intentTotal = activity?.total ?? 0;
          const intentPageCount = Math.max(1, Math.ceil(intentTotal / intentPageSize));
          const intentStart = intentOffset + 1;
          const intentEnd = Math.min(intentOffset + intentPageSize, intentTotal);
          const buildPageUrl = (p: number) => {
            const q = new URLSearchParams();
            if (profileId !== "default") q.set("profileId", profileId);            if (modeFilter !== defaultModeFilter) q.set("modeFilter", modeFilter);            if (p > 1) q.set("intentPage", String(p));
            const qs = q.toString();
            return qs ? `/?${qs}` : "/";
          };
          return (
            <>
              <div className="hk-card-header d-flex align-items-center justify-content-between">
                <span>Recent Intents</span>
                <div className="d-flex align-items-center gap-3">
                  <span style={{ fontSize: "0.68rem", fontWeight: 400, color: "var(--hk-text-dim)", letterSpacing: "0.05em" }}>
                    {intentTotal > 0 ? `${intentStart}–${intentEnd} of ${intentTotal}` : "0 intents"}
                    {" "}&nbsp;·&nbsp; <span style={{ color: "#888" }}>†</span> = pre-fix paper filter (ignored)
                  </span>
                  <div className="d-flex gap-1">
                    {intentPage > 1 ? (
                      <a
                        href={buildPageUrl(intentPage - 1)}
                        className="btn btn-sm"
                        style={{ fontSize: "0.72rem", padding: "2px 8px", background: "rgba(255,255,255,0.06)", color: "var(--hk-text)", border: "1px solid rgba(255,255,255,0.12)", borderRadius: 3 }}
                      >← Prev</a>
                    ) : (
                      <span
                        className="btn btn-sm disabled"
                        style={{ fontSize: "0.72rem", padding: "2px 8px", background: "transparent", color: "var(--hk-text-dim)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 3, cursor: "default" }}
                      >← Prev</span>
                    )}
                    <span style={{ fontSize: "0.72rem", color: "var(--hk-text-dim)", padding: "2px 4px", lineHeight: "1.8" }}>
                      {intentPage} / {intentPageCount}
                    </span>
                    {intentPage < intentPageCount ? (
                      <a
                        href={buildPageUrl(intentPage + 1)}
                        className="btn btn-sm"
                        style={{ fontSize: "0.72rem", padding: "2px 8px", background: "rgba(255,255,255,0.06)", color: "var(--hk-text)", border: "1px solid rgba(255,255,255,0.12)", borderRadius: 3 }}
                      >Next →</a>
                    ) : (
                      <span
                        className="btn btn-sm disabled"
                        style={{ fontSize: "0.72rem", padding: "2px 8px", background: "transparent", color: "var(--hk-text-dim)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 3, cursor: "default" }}
                      >Next →</span>
                    )}
                  </div>
                </div>
              </div>
        <div className="table-responsive">
          <table className="table table-sm table-striped mb-0 align-middle">
            <thead>
              <tr>
                <th>Time</th>
                <th>Market</th>
                <th>Side</th>
                <th>Status</th>
                <th className="text-end">Leader Shares</th>
                <th className="text-end">Our Shares</th>
                <th className="text-end">Notional</th>
                <th>Skip Reason</th>
              </tr>
            </thead>
            <tbody>
              {activity && activity.data.length > 0 ? (
                activity.data.map((item) => {
                  const reasonInfo = getSkipReasonInfo(item.reason);
                  return (
                    <tr key={item.id}>
                      <td style={{ color: "var(--hk-text-dim)", fontSize: "0.78rem", whiteSpace: "nowrap" }}>
                        {new Date(item.ts).toLocaleTimeString()}
                      </td>
                      <td className="token-cell" title={item.tokenId}>
                        {item.marketTitle ? (
                          <>
                            <div style={{ color: "var(--hk-text)", fontWeight: 500, fontSize: "0.78rem" }}>{item.marketTitle}</div>
                            <div className="token-subtext">{item.tokenId.slice(0, 14)}&hellip;</div>
                          </>
                        ) : (
                          <span style={{ fontSize: "0.78rem" }}>{item.tokenId.slice(0, 14)}&hellip;</span>
                        )}
                      </td>
                      <td style={{ color: item.side === "BUY" ? "#00e855" : "var(--hk-danger)", fontWeight: 600, fontSize: "0.78rem" }}>
                        {item.side}
                      </td>
                      <td>
                        <span style={getStatusPillStyle(item.status)}>
                          {getStatusLabel(item.status)}
                        </span>
                      </td>
                      <td className="text-end" style={{ fontSize: "0.78rem" }}>
                        {item.leaderSize > 0 ? item.leaderSize.toFixed(2) : <span style={{ color: "var(--hk-text-dim)" }}>—</span>}
                      </td>
                      <td className="text-end" style={{ fontSize: "0.78rem" }}>
                        {item.desiredSize > 0 ? item.desiredSize.toFixed(2) : <span style={{ color: "var(--hk-text-dim)" }}>—</span>}
                      </td>
                      <td className="text-end" style={{ fontSize: "0.78rem" }}>{formatUsd(item.desiredNotional)}</td>
                      <td>
                        {item.reason ? (
                          <span
                            title={item.reason}
                            style={{ color: reasonInfo.color, fontSize: "0.78rem", cursor: "help" }}
                          >
                            {reasonInfo.label}
                          </span>
                        ) : (
                          <span style={{ color: "var(--hk-text-dim)", fontSize: "0.75rem" }}>—</span>
                        )}
                      </td>
                    </tr>
                  );
                })
              ) : (
                <tr>
                  <td colSpan={8} className="py-3 text-center" style={{ color: "var(--hk-text-dim)" }}>
                    [ no recent activity ]
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
            </>
          );
        })()}
      </section>

      {/* ── Timeline ─────────────────────────────────────────── */}
      <section className="hk-card shadow-sm mb-4">
        <div className="hk-card-header">Intent → Order → Fill Timeline</div>
        <div className="table-responsive">
          <table className="table table-sm table-striped mb-0 align-middle">
            <thead>
              <tr>
                <th>Time</th>
                <th>Type</th>
                <th>Token</th>
                <th>Side</th>
                <th>Status</th>
                <th className="text-end">Price</th>
                <th className="text-end">Size</th>
                <th className="text-end">Notional</th>
              </tr>
            </thead>
            <tbody>
              {timeline && timeline.data.length > 0 ? (
                timeline.data.map((item) => (
                  <tr key={`${item.kind}-${item.id}`}>
                    <td style={{ color: "var(--hk-text-dim)" }}>{new Date(item.ts).toLocaleTimeString()}</td>
                    <td>
                      <span
                        style={{
                          color:
                            item.kind === "fill"
                              ? "#00ff41"
                              : item.kind === "order"
                              ? "#00cfff"
                              : "var(--hk-text-dim)",
                          fontSize: "0.72rem",
                          letterSpacing: "0.06em",
                        }}
                      >
                        {item.kind.toUpperCase()}
                      </span>
                    </td>
                    <td className="token-cell" title={item.tokenId ?? ""}>{item.tokenId ?? "-"}</td>
                    <td>{item.side ?? "-"}</td>
                    <td>{item.status ?? "-"}</td>
                    <td className="text-end">{typeof item.price === "number" ? item.price.toFixed(4) : "-"}</td>
                    <td className="text-end">{typeof item.size === "number" ? formatNumber(item.size) : "-"}</td>
                    <td className="text-end">
                      {typeof item.desiredNotional === "number" ? formatUsd(item.desiredNotional) : "-"}
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={8} className="py-3 text-center" style={{ color: "var(--hk-text-dim)" }}>
                    [ no timeline records ]
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* ── Alerts ───────────────────────────────────────────── */}
      <section className="hk-card shadow-sm mb-4">
        <div className="hk-card-header">System Alerts</div>
        <div className="card-body">
          {alerts && alerts.data.length > 0 ? (
            <ul className="list-unstyled mb-0">
              {alerts.data.map((alert) => (
                <li key={alert.id} className={`hk-alert-item hk-alert-${alert.severity.toLowerCase()}`}>
                  <span style={{ opacity: 0.6 }}>{new Date(alert.ts).toLocaleTimeString()} </span>
                  <strong>[{alert.severity}]</strong> {alert.code} — {alert.message}
                </li>
              ))}
            </ul>
          ) : (
            <p style={{ color: "var(--hk-text-dim)", fontSize: "0.8rem", margin: 0 }}>[ no alerts ]</p>
          )}
        </div>
      </section>
    </main>
  );
}

/* ── Components ──────────────────────────────────────────────── */

function StatCard({ label, value, subValue, valueColor }: { label: string; value: string; subValue?: string; valueColor?: string }) {
  return (
    <div className="card card-kpi border-0">
      <div className="card-body py-3 px-3">
        <div className="kpi-label">{label}</div>
        <div className="kpi-value" style={valueColor ? { color: valueColor } : undefined}>{value}</div>
        {subValue ? <div className="kpi-sub">{subValue}</div> : null}
      </div>
    </div>
  );
}

function LimitMeter({
  label,
  used,
  limit,
  usedLabel,
  limitLabel,
}: {
  label: string;
  used: number;
  limit: number;
  usedLabel: string;
  limitLabel: string;
}) {
  const safeLimit = limit > 0 ? limit : 0;
  const ratio = safeLimit > 0 ? used / safeLimit : 0;
  const pct = Math.max(0, Math.min(100, ratio * 100));
  const color = pct >= 90 ? "var(--hk-danger)" : pct >= 70 ? "#ff9500" : "#00e855";

  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.74rem" }}>
        <span style={{ color: "var(--hk-text-dim)", letterSpacing: "0.05em" }}>{label}</span>
        <span style={{ color }}>{usedLabel} / {limitLabel} ({pct.toFixed(0)}%)</span>
      </div>
      <div style={{ height: 7, background: "rgba(255,255,255,0.08)", borderRadius: 999 }}>
        <div style={{ width: `${pct}%`, height: "100%", background: color, borderRadius: 999 }} />
      </div>
    </div>
  );
}

function getTinyPillStyle(kind: "ok" | "warn" | "info"): CSSProperties {
  const base: CSSProperties = {
    display: "inline-block",
    padding: "0.12rem 0.45rem",
    borderRadius: 3,
    fontSize: "0.7rem",
    letterSpacing: "0.05em",
    border: "1px solid transparent",
  };
  if (kind === "ok") return { ...base, color: "#00e855", background: "rgba(0,232,85,0.12)", borderColor: "rgba(0,232,85,0.35)" };
  if (kind === "warn") return { ...base, color: "#ff9500", background: "rgba(255,149,0,0.12)", borderColor: "rgba(255,149,0,0.35)" };
  return { ...base, color: "#00cfff", background: "rgba(0,207,255,0.12)", borderColor: "rgba(0,207,255,0.35)" };
}

/* ── Helpers ─────────────────────────────────────────────────── */

function formatUsd(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(value);
}

function formatSignedUsd(value: number): string {
  const absolute = formatUsd(Math.abs(value));
  return value >= 0 ? `+${absolute}` : `-${absolute}`;
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 4,
  }).format(value);
}

function getStatusPillStyle(status: string): CSSProperties {
  const base: CSSProperties = {
    display: "inline-block",
    padding: "0.1em 0.5em",
    borderRadius: "3px",
    fontSize: "0.7rem",
    fontWeight: 700,
    letterSpacing: "0.06em",
  };
  switch (status) {
    case "FILLED":
    case "PARTIALLY_FILLED_OK":
      return { ...base, background: "rgba(0,255,65,0.15)", color: "#00ff41", border: "1px solid #00ff4155" };
    case "PLACED":
      return { ...base, background: "rgba(0,207,255,0.12)", color: "#00cfff", border: "1px solid #00cfff55" };
    case "SKIPPED":
      return { ...base, background: "rgba(255,149,0,0.12)", color: "#ff9500", border: "1px solid #ff950044" };
    case "FAILED":
      return { ...base, background: "rgba(255,0,60,0.12)", color: "var(--hk-danger)", border: "1px solid var(--hk-danger)" };
    default:
      return { ...base, background: "var(--hk-surface-2)", color: "var(--hk-text-dim)", border: "1px solid transparent" };
  }
}

function getStatusLabel(status: string): string {
  switch (status) {
    case "PARTIALLY_FILLED_OK": return "FILLED";
    case "PLACED":  return "PLACED";
    case "SKIPPED": return "SKIP";
    case "FAILED":  return "FAIL";
    case "FILLED":  return "FILLED";
    default:        return status;
  }
}

type ReasonInfo = { label: string; color: string };

function getSkipReasonInfo(reason: string | null): ReasonInfo {
  if (!reason) return { label: "", color: "" };
  switch (reason) {
    // Safety interlocks — legitimate stops
    case "KILL_SWITCH":           return { label: "Kill switch",     color: "var(--hk-danger)" };
    case "PAUSED":                return { label: "Paused",          color: "#ff9500" };
    case "DRAWDOWN_STOP":         return { label: "Drawdown stop",   color: "var(--hk-danger)" };
    // Real filters — valid trade logic
    case "PRICE_FILTER":                         return { label: "Price filter",    color: "#ff9500" };
    case "EVENT_TOO_OLD":                         return { label: "Event stale",     color: "#ff9500" };
    case "MIN_ORDER_NOTIONAL":                    return { label: "Min $/order",     color: "#ff9500" };
    case "MIN_ORDER_SHARES":                      return { label: "Min shares",      color: "#ff9500" };
    case "NO_POSITION_TO_SELL":                   return { label: "No position",     color: "#888" };
    case "COPY_SIDE_DISABLED":                    return { label: "Side disabled",   color: "#888" };
    case "MAX_OPEN_MARKETS":                      return { label: "Max markets",     color: "#ff9500" };
    case "MAX_NOTIONAL_PER_MARKET":               return { label: "Market cap",      color: "#ff9500" };
    case "MAX_DAILY_NOTIONAL":                    return { label: "Daily limit",     color: "#ff9500" };
    case "INSUFFICIENT_AVAILABLE_AFTER_RESERVE":  return { label: "Cash reserved",   color: "#ff9500" };
    case "DUPLICATE_EVENT":                       return { label: "Duplicate",       color: "#888" };
    // Venue checks — valid in both LIVE and PAPER modes
    case "SPREAD_TOO_WIDE":        return { label: "Spread wide",    color: "#ff9500" };
    case "SLIPPAGE_TOO_HIGH":      return { label: "Slippage high",  color: "#ff9500" };
    case "INSUFFICIENT_LIQUIDITY": return { label: "Low liquidity",  color: "#ff9500" };
    default:                       return { label: reason,            color: "var(--hk-text-dim)" };
  }
}

function getRuntimeStatusLabel(summary: SummaryResponse | null): string {
  if (!summary) return "OFFLINE";
  if (summary.control.killSwitch) return "KILLED";
  if (summary.control.paused) return "PAUSED";
  return "RUNNING";
}

function getRuntimeBadgeClass(summary: SummaryResponse | null): string {
  if (!summary) return "text-bg-secondary";
  if (summary.control.killSwitch) return "text-bg-danger";
  if (summary.control.paused) return "text-bg-warning";
  return "text-bg-success";
}

function getMarketStatusStyle(status: PositionSummaryRow["marketStatus"]): CSSProperties {
  const base: CSSProperties = {
    display: "inline-block",
    padding: "0.1em 0.5em",
    borderRadius: "3px",
    fontSize: "0.68rem",
    fontWeight: 700,
    letterSpacing: "0.05em"
  };
  switch (status) {
    case "RESOLVED":
      return { ...base, background: "rgba(0,255,65,0.15)", color: "#00ff41", border: "1px solid #00ff4155" };
    case "SOLD_OUT":
      return { ...base, background: "rgba(0,207,255,0.12)", color: "#00cfff", border: "1px solid #00cfff55" };
    case "UNKNOWN":
      return { ...base, background: "rgba(255,149,0,0.12)", color: "#ff9500", border: "1px solid #ff950044" };
    default:
      return { ...base, background: "var(--hk-surface-2)", color: "var(--hk-text-dim)", border: "1px solid transparent" };
  }
}
