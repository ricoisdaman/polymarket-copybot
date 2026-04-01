export const dynamic = "force-dynamic";

const apiBaseUrl = process.env.API_BASE_URL ?? "http://localhost:4000";

type ProfilesResponse = {
  profiles: string[];
};

type SummaryResponse = {
  leaderEvents: number;
  intents: number;
  openPositions: number;
  alerts: number;
  cashBalance: number;
  drawdownUSDC: number;
  startingBalanceUSDC: number;
  mode: "PAPER" | "LIVE";
  control: {
    killSwitch: boolean;
    paused: boolean;
  };
  ts: number;
};

type PositionsSummaryResponse = {
  open: {
    tokenId: string;
    marketTitle: string;
    amount: number;
    shares: number;
    currentValue: number;
    pnl: number;
    lastPrice: number;
    updatedAt: string;
  }[];
  closed: {
    tokenId: string;
    marketTitle: string;
    amount: number;
    shares: number;
    currentValue: number;
    pnl: number;
    lastPrice: number;
    updatedAt: string;
  }[];
};

async function fetchJson<T>(path: string): Promise<T | null> {
  try {
    const response = await fetch(`${apiBaseUrl}${path}`, { cache: "no-store" });
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

function formatUsd(value: number): string {
  return `$${Math.abs(value).toFixed(2)}`;
}

function pnlColor(value: number): string {
  if (value > 0) return "#22c55e";
  if (value < 0) return "#ef4444";
  return "var(--hk-muted)";
}

type ProfileData = {
  profileId: string;
  summary: SummaryResponse | null;
  positions: PositionsSummaryResponse | null;
};

export default async function ComparePage() {
  const profilesData = await fetchJson<ProfilesResponse>("/profiles/list");
  const profiles = profilesData?.profiles ?? [];

  if (profiles.length === 0) {
    return (
      <main className="container dashboard-shell py-4">
        <div className="d-flex align-items-center justify-content-between mb-4">
          <h1 className="h3 mb-0 hk-title">PROFILE COMPARE</h1>
          <a href="/" className="btn btn-sm btn-outline-secondary" style={{ fontSize: "0.74rem" }}>← BACK</a>
        </div>
        <div className="hk-card p-4 text-center" style={{ color: "var(--hk-muted)" }}>
          No profiles found. Start at least one bot to create a profile.
        </div>
      </main>
    );
  }

  const profileDataList: ProfileData[] = await Promise.all(
    profiles.map(async (pid) => {
      const [summary, positions] = await Promise.all([
        fetchJson<SummaryResponse>(`/status/summary?profileId=${encodeURIComponent(pid)}`),
        fetchJson<PositionsSummaryResponse>(`/positions/summary?profileId=${encodeURIComponent(pid)}`)
      ]);
      return { profileId: pid, summary, positions };
    })
  );

  // Cash-based P&L: avoids the broken position-sum approach where YES-resolved
  // markets appear as full losses (no SELL fill, position zeroed on-chain).
  // This matches the formula used on the individual profile page.
  const totalPnlByProfile = (data: ProfileData): number => {
    const cash = data.summary?.cashBalance ?? 0;
    const openMark = (data.positions?.open ?? []).reduce((s, p) => s + p.currentValue, 0);
    const startingBalance = data.summary?.startingBalanceUSDC ?? 50;
    return cash + openMark - startingBalance;
  };

  const portfolioValue = (data: ProfileData): number => {
    const cash = data.summary?.cashBalance ?? 0;
    const openValue = (data.positions?.open ?? []).reduce((s, p) => s + p.currentValue, 0);
    return cash + openValue;
  };

  const roiPct = (data: ProfileData): number | null => {
    const starting = data.summary?.startingBalanceUSDC;
    if (!starting || starting === 0) return null;
    return (totalPnlByProfile(data) / starting) * 100;
  };

  return (
    <main className="container dashboard-shell py-4">
      <div className="d-flex align-items-center justify-content-between mb-4">
        <div>
          <h1 className="h3 mb-0 hk-title">PROFILE COMPARE</h1>
          <p className="hk-subtitle mb-0">// side-by-side leader performance</p>
        </div>
        <a href="/" className="btn btn-sm btn-outline-secondary" style={{ fontSize: "0.74rem", letterSpacing: "0.06em" }}>← BACK</a>
      </div>

      {/* ── KPI Comparison Table ── */}
      <section className="hk-card shadow-sm mb-4">
        <div className="hk-card-header">KPI Summary</div>
        <div className="table-responsive">
          <table className="table table-sm mb-0 align-middle">
            <thead>
              <tr>
                <th>Metric</th>
                {profileDataList.map((d) => (
                  <th key={d.profileId} className="text-center">
                    <a href={`/?profileId=${encodeURIComponent(d.profileId)}`} style={{ color: "var(--hk-accent)", textDecoration: "none", textTransform: "uppercase", letterSpacing: "0.06em" }}>
                      {d.profileId}
                    </a>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="text-muted" style={{ fontSize: "0.78rem" }}>Status</td>
                {profileDataList.map((d) => (
                  <td key={d.profileId} className="text-center">
                    {d.summary?.control.killSwitch
                      ? <span className="badge bg-danger" style={{ fontSize: "0.68rem" }}>KILL SWITCH</span>
                      : d.summary?.control.paused
                        ? (
                          <span>
                            <span className="badge bg-warning text-dark" style={{ fontSize: "0.68rem" }}>PAUSED</span>
                            {" "}
                            <a href={`/?profileId=${encodeURIComponent(d.profileId)}`} style={{ fontSize: "0.64rem", color: "var(--hk-accent)" }}>resume ↗</a>
                          </span>
                        )
                        : d.summary
                          ? <span className="badge bg-success" style={{ fontSize: "0.68rem" }}>RUNNING</span>
                          : <span className="badge bg-secondary" style={{ fontSize: "0.68rem" }}>OFFLINE</span>
                    }
                  </td>
                ))}
              </tr>
              <tr>
                <td className="text-muted" style={{ fontSize: "0.78rem" }}>Portfolio Value</td>
                {profileDataList.map((d) => (
                  <td key={d.profileId} className="text-center" style={{ fontFamily: "monospace" }}>
                    {formatUsd(portfolioValue(d))}
                  </td>
                ))}
              </tr>
              <tr>
                <td className="text-muted" style={{ fontSize: "0.78rem" }}>Cash Balance</td>
                {profileDataList.map((d) => (
                  <td key={d.profileId} className="text-center" style={{ fontFamily: "monospace" }}>
                    {formatUsd(d.summary?.cashBalance ?? 0)}
                  </td>
                ))}
              </tr>
              <tr>
                <td className="text-muted" style={{ fontSize: "0.78rem" }}>Total P&amp;L</td>
                {profileDataList.map((d) => {
                  const pnl = totalPnlByProfile(d);
                  return (
                    <td key={d.profileId} className="text-center" style={{ fontFamily: "monospace", color: pnlColor(pnl), fontWeight: 600 }}>
                      {pnl >= 0 ? "+" : "-"}{formatUsd(pnl)}
                    </td>
                  );
                })}
              </tr>
              <tr>
                <td className="text-muted" style={{ fontSize: "0.78rem" }}>ROI</td>
                {profileDataList.map((d) => {
                  const roi = roiPct(d);
                  if (roi === null) return <td key={d.profileId} className="text-center" style={{ color: "var(--hk-muted)", fontSize: "0.78rem" }}>—</td>;
                  return (
                    <td key={d.profileId} className="text-center" style={{ fontFamily: "monospace", fontSize: "0.78rem", color: pnlColor(roi) }}>
                      {roi >= 0 ? "+" : ""}{roi.toFixed(1)}%
                    </td>
                  );
                })}
              </tr>
              <tr>
                <td className="text-muted" style={{ fontSize: "0.78rem" }}>Open Positions</td>
                {profileDataList.map((d) => (
                  <td key={d.profileId} className="text-center">
                    {d.positions?.open.length ?? 0}
                  </td>
                ))}
              </tr>
              <tr>
                <td className="text-muted" style={{ fontSize: "0.78rem" }}>Closed Positions</td>
                {profileDataList.map((d) => (
                  <td key={d.profileId} className="text-center">
                    {d.positions?.closed.length ?? 0}
                  </td>
                ))}
              </tr>
              <tr>
                <td className="text-muted" style={{ fontSize: "0.78rem" }}>Copy Intents</td>
                {profileDataList.map((d) => (
                  <td key={d.profileId} className="text-center">
                    {d.summary?.intents ?? 0}
                  </td>
                ))}
              </tr>
              <tr>
                <td className="text-muted" style={{ fontSize: "0.78rem" }}>Leader Events</td>
                {profileDataList.map((d) => (
                  <td key={d.profileId} className="text-center">
                    {d.summary?.leaderEvents ?? 0}
                  </td>
                ))}
              </tr>
              <tr>
                <td className="text-muted" style={{ fontSize: "0.78rem" }}>Alerts</td>
                {profileDataList.map((d) => (
                  <td key={d.profileId} className="text-center">
                    {d.summary?.alerts ?? 0}
                  </td>
                ))}
              </tr>
              <tr>
                <td className="text-muted" style={{ fontSize: "0.78rem" }}>Session Drawdown</td>
                {profileDataList.map((d) => {
                  const dd = d.summary?.drawdownUSDC ?? 0;
                  return (
                    <td key={d.profileId} className="text-center" style={{ fontFamily: "monospace", fontSize: "0.78rem", color: dd > 0 ? "var(--hk-danger)" : "var(--hk-muted)" }}>
                      {dd > 0 ? `-$${dd.toFixed(2)}` : "—"}
                    </td>
                  );
                })}
              </tr>
              <tr>
                <td className="text-muted" style={{ fontSize: "0.78rem" }}>Starting Balance</td>
                {profileDataList.map((d) => (
                  <td key={d.profileId} className="text-center" style={{ fontFamily: "monospace", fontSize: "0.78rem", color: "var(--hk-muted)" }}>
                    {d.summary?.startingBalanceUSDC ? `$${d.summary.startingBalanceUSDC.toFixed(2)}` : "—"}
                  </td>
                ))}
              </tr>
              <tr>
                <td className="text-muted" style={{ fontSize: "0.78rem" }}>Mode</td>
                {profileDataList.map((d) => (
                  <td key={d.profileId} className="text-center" style={{ fontSize: "0.74rem", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                    {d.summary?.mode ?? "—"}
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      {/* ── Open Positions per Profile ── */}
      {profileDataList.map((d) => {
        const open = d.positions?.open ?? [];
        if (open.length === 0) return null;
        return (
          <section key={d.profileId} className="hk-card shadow-sm mb-4">
            <div className="hk-card-header">
              Open Positions — <span style={{ color: "var(--hk-accent)", textTransform: "uppercase" }}>{d.profileId}</span>
            </div>
            <div className="table-responsive">
              <table className="table table-sm mb-0 align-middle">
                <thead>
                  <tr>
                    <th>Market</th>
                    <th className="text-end">Shares</th>
                    <th className="text-end">Cur. Value</th>
                    <th className="text-end">P&amp;L</th>
                    <th className="text-end">Mark Price</th>
                  </tr>
                </thead>
                <tbody>
                  {open.map((p) => (
                    <tr key={`${d.profileId}-${p.tokenId}`}>
                      <td style={{ fontSize: "0.78rem", maxWidth: "260px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={p.tokenId}>
                        {p.marketTitle.length > 42 ? p.marketTitle.slice(0, 40) + "…" : p.marketTitle}
                      </td>
                      <td className="text-end" style={{ fontFamily: "monospace", fontSize: "0.78rem" }}>{p.shares.toFixed(3)}</td>
                      <td className="text-end" style={{ fontFamily: "monospace", fontSize: "0.78rem" }}>{formatUsd(p.currentValue)}</td>
                      <td className="text-end" style={{ fontFamily: "monospace", fontSize: "0.78rem", color: pnlColor(p.pnl) }}>
                        {p.pnl >= 0 ? "+" : "-"}{formatUsd(p.pnl)}
                      </td>
                      <td className="text-end" style={{ fontFamily: "monospace", fontSize: "0.78rem" }}>{(p.lastPrice * 100).toFixed(1)}¢</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        );
      })}
    </main>
  );
}
