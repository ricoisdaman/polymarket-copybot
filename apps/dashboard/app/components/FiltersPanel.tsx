"use client";

import { useState, useEffect, useCallback } from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from "recharts";

type SportFilter = { min: number; max: number };
type SportStats = {
  sport: string;
  trades: number;
  wins: number;
  losses: number;
  open: number;
  winRate: number;
  pnl: number;
  totalCost: number;
};
type SimulateResult = {
  total: number;
  wouldTrade: number;
  wouldBlock: number;
  blockRate: number;
};

const SPORT_LABELS: Record<string, string> = {
  tennis: "Tennis (ATP/WTA)",
  mlb: "MLB",
  nba: "NBA",
  nhl: "NHL",
  nfl: "NFL",
  ncaa_bb: "NCAA Basketball",
  soccer: "Soccer",
  other: "Other",
};

const SPORT_ORDER = ["tennis", "mlb", "nba", "nhl", "nfl", "ncaa_bb", "soccer", "other"];

function PriceSlider({
  label,
  min,
  max,
  onMinChange,
  onMaxChange,
}: {
  label: string;
  min: number;
  max: number;
  onMinChange: (v: number) => void;
  onMaxChange: (v: number) => void;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.68rem", color: "var(--hk-text-dim)" }}>
        <span>{label}</span>
        <span style={{ color: "var(--hk-accent)" }}>
          {min.toFixed(2)} — {max.toFixed(2)}
        </span>
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <span style={{ fontSize: "0.65rem", color: "var(--hk-text-dim)", width: 28 }}>MIN</span>
        <input
          type="range"
          min={0.01}
          max={0.99}
          step={0.01}
          value={min}
          onChange={(e) => {
            const v = Number(e.target.value);
            if (v < max) onMinChange(v);
          }}
          style={{ flex: 1, accentColor: "var(--hk-accent)" }}
        />
        <span style={{ fontSize: "0.65rem", color: "var(--hk-text-dim)", width: 28 }}>MAX</span>
        <input
          type="range"
          min={0.01}
          max={0.99}
          step={0.01}
          value={max}
          onChange={(e) => {
            const v = Number(e.target.value);
            if (v > min) onMaxChange(v);
          }}
          style={{ flex: 1, accentColor: "var(--hk-accent)" }}
        />
      </div>
    </div>
  );
}

function PnlBadge({ pnl }: { pnl: number }) {
  const color = pnl >= 0 ? "#00e855" : "var(--hk-danger)";
  return (
    <span style={{ color, fontSize: "0.7rem", fontWeight: 600 }}>
      {pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}
    </span>
  );
}

function WinRateBadge({ rate, trades }: { rate: number; trades: number }) {
  const pct = (rate * 100).toFixed(0);
  const color = rate >= 0.7 ? "#00e855" : rate >= 0.55 ? "var(--hk-warning)" : "var(--hk-danger)";
  return (
    <span style={{ color, fontSize: "0.7rem" }}>
      {pct}% ({trades} trades)
    </span>
  );
}

type Props = {
  profileId: string;
  apiBaseUrl?: string;
};

export default function FiltersPanel({ profileId, apiBaseUrl = "http://localhost:4000" }: Props) {
  const [globalMin, setGlobalMin] = useState(0.60);
  const [globalMax, setGlobalMax] = useState(0.88);
  const [sportFilters, setSportFilters] = useState<Record<string, SportFilter>>({});
  const [enabledSports, setEnabledSports] = useState<Record<string, boolean>>({});
  const [blockedKeywords, setBlockedKeywords] = useState<string[]>([]);
  const [keywordInput, setKeywordInput] = useState("");

  const [stats, setStats] = useState<SportStats[]>([]);
  const [statsLoading, setStatsLoading] = useState(true);

  const [simResult, setSimResult] = useState<SimulateResult | null>(null);
  const [simLoading, setSimLoading] = useState(false);

  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [restartBanner, setRestartBanner] = useState(false);

  const q = profileId !== "default" ? `?profileId=${encodeURIComponent(profileId)}` : "";

  // Load current filter config
  useEffect(() => {
    void fetch(`${apiBaseUrl}/config/sport-filters${q}`)
      .then((r) => r.json())
      .then((data: {
        global: { min: number; max: number };
        sports: Record<string, SportFilter>;
        blockedTitleKeywords: string[];
      }) => {
        setGlobalMin(data.global?.min ?? 0.60);
        setGlobalMax(data.global?.max ?? 0.88);
        const sports = data.sports ?? {};
        setSportFilters(sports);
        const enabled: Record<string, boolean> = {};
        for (const s of SPORT_ORDER) enabled[s] = s in sports;
        setEnabledSports(enabled);
        setBlockedKeywords(data.blockedTitleKeywords ?? []);
      })
      .catch(() => { /* keep defaults */ });
  }, [apiBaseUrl, q]);

  // Load sport stats
  useEffect(() => {
    setStatsLoading(true);
    void fetch(`${apiBaseUrl}/analytics/sport-stats${q}&days=30`)
      .then((r) => r.json())
      .then((data: { sports: SportStats[] }) => {
        setStats(data.sports ?? []);
      })
      .finally(() => setStatsLoading(false));
  }, [apiBaseUrl, q]);

  const runSimulate = useCallback(async () => {
    setSimLoading(true);
    setSimResult(null);
    try {
      const activeSports = Object.entries(sportFilters)
        .filter(([k]) => enabledSports[k])
        .map(([k, v]) => `${k}:${v.min}:${v.max}`)
        .join(",");
      const params = new URLSearchParams();
      if (profileId !== "default") params.set("profileId", profileId);
      params.set("globalMin", String(globalMin));
      params.set("globalMax", String(globalMax));
      if (activeSports) params.set("sports", activeSports);
      params.set("days", "30");
      const r = await fetch(`${apiBaseUrl}/analytics/sport-stats/simulate?${params.toString()}`);
      const data = await r.json() as SimulateResult;
      setSimResult(data);
    } finally {
      setSimLoading(false);
    }
  }, [apiBaseUrl, profileId, globalMin, globalMax, sportFilters, enabledSports]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const activeSportFilters: Record<string, SportFilter> = {};
      for (const [sport, enabled] of Object.entries(enabledSports)) {
        if (enabled && sportFilters[sport]) {
          activeSportFilters[sport] = sportFilters[sport];
        }
      }
      const pq = profileId !== "default" ? `?profileId=${encodeURIComponent(profileId)}` : "";
      await fetch(`${apiBaseUrl}/config/sport-filters${pq}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          global: { min: globalMin, max: globalMax },
          sports: activeSportFilters,
          blockedTitleKeywords: blockedKeywords,
        }),
      });
      setSaved(true);
      setRestartBanner(true);
      setTimeout(() => setSaved(false), 3000);
    } finally {
      setSaving(false);
    }
  };

  const toggleSport = (sport: string) => {
    setEnabledSports((prev) => {
      const next = { ...prev, [sport]: !prev[sport] };
      if (next[sport] && !sportFilters[sport]) {
        setSportFilters((sf) => ({ ...sf, [sport]: { min: globalMin, max: globalMax } }));
      }
      return next;
    });
  };

  const addKeyword = () => {
    const kw = keywordInput.trim().toLowerCase();
    if (kw && !blockedKeywords.includes(kw)) {
      setBlockedKeywords((prev) => [...prev, kw]);
      setKeywordInput("");
    }
  };

  const removeKeyword = (kw: string) => setBlockedKeywords((prev) => prev.filter((k) => k !== kw));

  // Chart data: trades per sport (last 30 days)
  const chartData = SPORT_ORDER
    .map((sport) => {
      const s = stats.find((x) => x.sport === sport);
      return { sport: SPORT_LABELS[sport] ?? sport, trades: s?.trades ?? 0, pnl: s?.pnl ?? 0 };
    })
    .filter((d) => d.trades > 0);

  const cardStyle: React.CSSProperties = {
    background: "var(--hk-surface)",
    border: "1px solid var(--hk-border)",
    borderRadius: 4,
    padding: "12px 14px",
    marginBottom: 0,
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>

      {/* ── Restart Banner ──────────────────────────────────── */}
      {restartBanner && (
        <div
          style={{
            background: "rgba(255,193,7,0.10)",
            border: "1px solid var(--hk-warning)",
            borderRadius: 4,
            padding: "7px 12px",
            fontSize: "0.75rem",
            color: "var(--hk-warning)",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <span>⚠ Filters saved — <strong>restart bot-worker-v2</strong> to apply changes.</span>
          <button
            onClick={() => setRestartBanner(false)}
            style={{ background: "none", border: "none", color: "var(--hk-text-dim)", cursor: "pointer", fontSize: "0.8rem" }}
          >✕</button>
        </div>
      )}

      <div className="row g-3">
        {/* LEFT column: sliders */}
        <div className="col-12 col-lg-7">
          <div style={cardStyle}>
            <div style={{ fontSize: "0.72rem", color: "var(--hk-text-dim)", letterSpacing: "0.06em", marginBottom: 10 }}>
              PRICE FILTER OVERRIDES
            </div>

            {/* Global */}
            <div style={{ marginBottom: 14 }}>
              <PriceSlider
                label="Global (fallback for all sports)"
                min={globalMin}
                max={globalMax}
                onMinChange={setGlobalMin}
                onMaxChange={setGlobalMax}
              />
            </div>

            {/* Per-sport rows */}
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {SPORT_ORDER.map((sport) => {
                const s = stats.find((x) => x.sport === sport);
                const enabled = enabledSports[sport] ?? false;
                const filter = sportFilters[sport] ?? { min: globalMin, max: globalMax };
                return (
                  <div
                    key={sport}
                    style={{
                      padding: "8px 10px",
                      border: `1px solid ${enabled ? "var(--hk-border)" : "rgba(255,255,255,0.04)"}`,
                      borderRadius: 3,
                      background: enabled ? "var(--hk-surface-2)" : "rgba(0,0,0,0.2)",
                      opacity: enabled ? 1 : 0.5,
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: enabled ? 8 : 0 }}>
                      <input
                        type="checkbox"
                        checked={enabled}
                        onChange={() => toggleSport(sport)}
                        style={{ accentColor: "var(--hk-accent)", cursor: "pointer" }}
                      />
                      <span style={{ fontSize: "0.74rem", flex: 1, color: enabled ? "var(--hk-text)" : "var(--hk-text-dim)" }}>
                        {SPORT_LABELS[sport] ?? sport}
                      </span>
                      {s && (
                        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                          <WinRateBadge rate={s.winRate} trades={s.trades} />
                          <PnlBadge pnl={s.pnl} />
                        </div>
                      )}
                      {!s && !statsLoading && (
                        <span style={{ fontSize: "0.65rem", color: "var(--hk-text-dim)" }}>no data</span>
                      )}
                    </div>
                    {enabled && (
                      <PriceSlider
                        label={`${SPORT_LABELS[sport]} override`}
                        min={filter.min}
                        max={filter.max}
                        onMinChange={(v) => setSportFilters((prev) => ({ ...prev, [sport]: { ...prev[sport] ?? filter, min: v } }))}
                        onMaxChange={(v) => setSportFilters((prev) => ({ ...prev, [sport]: { ...prev[sport] ?? filter, max: v } }))}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* RIGHT column: keywords + chart + simulate */}
        <div className="col-12 col-lg-5" style={{ display: "flex", flexDirection: "column", gap: 12 }}>

          {/* Keywords editor */}
          <div style={cardStyle}>
            <div style={{ fontSize: "0.72rem", color: "var(--hk-text-dim)", letterSpacing: "0.06em", marginBottom: 8 }}>
              BLOCKED TITLE KEYWORDS
            </div>
            <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
              <input
                type="text"
                value={keywordInput}
                onChange={(e) => setKeywordInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && addKeyword()}
                placeholder="add keyword..."
                style={{
                  flex: 1,
                  background: "var(--hk-bg)",
                  border: "1px solid var(--hk-border)",
                  borderRadius: 3,
                  color: "var(--hk-text)",
                  fontSize: "0.72rem",
                  padding: "4px 8px",
                }}
              />
              <button
                onClick={addKeyword}
                style={{
                  background: "var(--hk-accent)",
                  border: "none",
                  borderRadius: 3,
                  color: "#000",
                  fontSize: "0.7rem",
                  fontWeight: 700,
                  padding: "4px 10px",
                  cursor: "pointer",
                }}
              >ADD</button>
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
              {blockedKeywords.length === 0 && (
                <span style={{ fontSize: "0.68rem", color: "var(--hk-text-dim)" }}>[ none ]</span>
              )}
              {blockedKeywords.map((kw) => (
                <span
                  key={kw}
                  style={{
                    background: "rgba(255,62,62,0.12)",
                    border: "1px solid rgba(255,62,62,0.3)",
                    borderRadius: 3,
                    padding: "2px 7px",
                    fontSize: "0.68rem",
                    color: "var(--hk-danger)",
                    display: "flex",
                    alignItems: "center",
                    gap: 5,
                    cursor: "pointer",
                  }}
                  title="Click to remove"
                  onClick={() => removeKeyword(kw)}
                >
                  {kw} ✕
                </span>
              ))}
            </div>
          </div>

          {/* Volume bar chart */}
          <div style={cardStyle}>
            <div style={{ fontSize: "0.72rem", color: "var(--hk-text-dim)", letterSpacing: "0.06em", marginBottom: 8 }}>
              TRADES / SPORT (LAST 30 DAYS)
            </div>
            {statsLoading ? (
              <div style={{ fontSize: "0.7rem", color: "var(--hk-text-dim)", textAlign: "center", padding: "20px 0" }}>loading…</div>
            ) : chartData.length === 0 ? (
              <div style={{ fontSize: "0.7rem", color: "var(--hk-text-dim)", textAlign: "center", padding: "20px 0" }}>[ no data ]</div>
            ) : (
              <ResponsiveContainer width="100%" height={120}>
                <BarChart data={chartData} margin={{ top: 0, right: 8, left: -20, bottom: 0 }}>
                  <XAxis
                    dataKey="sport"
                    tick={{ fill: "var(--hk-text-dim)", fontSize: 9 }}
                    axisLine={false}
                    tickLine={false}
                    interval={0}
                    angle={-30}
                    textAnchor="end"
                    height={36}
                  />
                  <YAxis tick={{ fill: "var(--hk-text-dim)", fontSize: 9 }} axisLine={false} tickLine={false} />
                  <Tooltip
                    contentStyle={{ background: "var(--hk-surface)", border: "1px solid var(--hk-border)", fontSize: "0.7rem" }}
                    itemStyle={{ color: "var(--hk-text)" }}
                    cursor={{ fill: "rgba(0,255,65,0.06)" }}
                  />
                  <Bar dataKey="trades" radius={[2, 2, 0, 0]}>
                    {chartData.map((entry, idx) => (
                      <Cell
                        key={idx}
                        fill={entry.pnl >= 0 ? "var(--hk-accent)" : "var(--hk-danger)"}
                        opacity={0.75}
                      />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>

          {/* Simulate impact */}
          <div style={cardStyle}>
            <div style={{ fontSize: "0.72rem", color: "var(--hk-text-dim)", letterSpacing: "0.06em", marginBottom: 8 }}>
              SIMULATE IMPACT (30 DAYS)
            </div>
            <button
              onClick={runSimulate}
              disabled={simLoading}
              style={{
                background: simLoading ? "rgba(0,255,65,0.12)" : "rgba(0,255,65,0.18)",
                border: "1px solid var(--hk-accent)",
                borderRadius: 3,
                color: "var(--hk-accent)",
                fontSize: "0.72rem",
                fontWeight: 700,
                padding: "5px 14px",
                cursor: simLoading ? "default" : "pointer",
                letterSpacing: "0.05em",
                marginBottom: 8,
                width: "100%",
              }}
            >
              {simLoading ? "SIMULATING…" : "▶ RUN SIMULATE"}
            </button>
            {simResult && (
              <div style={{ display: "flex", flexDirection: "column", gap: 5, fontSize: "0.72rem" }}>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ color: "var(--hk-text-dim)" }}>Total leader events</span>
                  <span>{simResult.total}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ color: "#00e855" }}>Would trade</span>
                  <span style={{ color: "#00e855", fontWeight: 700 }}>{simResult.wouldTrade}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ color: "var(--hk-danger)" }}>Would block</span>
                  <span style={{ color: "var(--hk-danger)", fontWeight: 700 }}>{simResult.wouldBlock}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ color: "var(--hk-text-dim)" }}>Block rate</span>
                  <span>{(simResult.blockRate * 100).toFixed(1)}%</span>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Save button */}
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <button
          onClick={handleSave}
          disabled={saving}
          style={{
            background: saved ? "rgba(0,232,85,0.18)" : "rgba(0,255,65,0.18)",
            border: `1px solid ${saved ? "#00e855" : "var(--hk-accent)"}`,
            borderRadius: 3,
            color: saved ? "#00e855" : "var(--hk-accent)",
            fontSize: "0.74rem",
            fontWeight: 700,
            padding: "6px 20px",
            cursor: saving ? "default" : "pointer",
            letterSpacing: "0.07em",
          }}
        >
          {saved ? "SAVED ✓" : saving ? "SAVING…" : "SAVE FILTERS"}
        </button>
      </div>
    </div>
  );
}
