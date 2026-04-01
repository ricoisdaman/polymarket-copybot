"use client";

import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  Legend,
} from "recharts";

export type PieSlice = { name: string; value: number };
export type PnlPoint = { time: string; pnl: number };

interface Props {
  pieData: PieSlice[];
  pnlData: PnlPoint[];
}

// Hacker-palette slice colours (green → teal → cyan)
const SLICE_COLOURS = [
  "#00ff41",
  "#00e5cc",
  "#00cfff",
  "#adff2f",
  "#00ff99",
  "#00b8d4",
  "#76ff03",
  "#18ffff",
];

function formatUsd(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(value);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function PnlTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  const val: number = payload[0].value;
  return (
    <div
      style={{
        background: "#0c1210",
        border: "1px solid #1c3c1c",
        padding: "8px 12px",
        fontFamily: "inherit",
        fontSize: "0.78rem",
      }}
    >
      <p style={{ color: "#00ff41", margin: 0 }}>{label}</p>
      <p style={{ color: val >= 0 ? "#00e855" : "#ff3e3e", margin: 0 }}>
        P&amp;L: {val >= 0 ? "+" : ""}{formatUsd(val)}
      </p>
    </div>
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function PieTooltip({ active, payload }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div
      style={{
        background: "#0c1210",
        border: "1px solid #1c3c1c",
        padding: "8px 12px",
        fontFamily: "inherit",
        fontSize: "0.78rem",
      }}
    >
      <p style={{ color: "#00ff41", margin: 0 }}>{payload[0].name}</p>
      <p style={{ color: "#b8e8b8", margin: 0 }}>{formatUsd(payload[0].value)}</p>
      <p style={{ color: "#3d7a3d", margin: 0 }}>
        {(payload[0].payload.percent * 100).toFixed(1)}%
      </p>
    </div>
  );
}

export default function PortfolioCharts({ pieData, pnlData }: Props) {
  const hasPie = pieData.some((d) => d.value > 0);
  const hasPnl = pnlData.length > 0;

  const minPnl = hasPnl ? Math.min(...pnlData.map((d) => d.pnl)) : 0;
  const maxPnl = hasPnl ? Math.max(...pnlData.map((d) => d.pnl)) : 0;
  const pnlPadding = Math.max(Math.abs(maxPnl - minPnl) * 0.15, 0.5);

  return (
    <div className="row g-3">
      {/* ── Allocation pie ─────────────────────────────────────── */}
      <div className="col-12 col-lg-5">
        <div className="hk-card h-100">
          <div className="hk-card-header">Portfolio Allocation</div>
          <div className="card-body p-2">
            {hasPie ? (
              <div className="chart-container">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <defs>
                      {SLICE_COLOURS.map((colour, i) => (
                        <radialGradient key={i} id={`slice-grad-${i}`} cx="50%" cy="50%" r="50%">
                          <stop offset="0%" stopColor={colour} stopOpacity={0.9} />
                          <stop offset="100%" stopColor={colour} stopOpacity={0.5} />
                        </radialGradient>
                      ))}
                    </defs>
                    <Pie
                      data={pieData}
                      cx="50%"
                      cy="50%"
                      innerRadius="45%"
                      outerRadius="70%"
                      paddingAngle={3}
                      dataKey="value"
                      nameKey="name"
                    >
                      {pieData.map((_, index) => (
                        <Cell
                          key={`cell-${index}`}
                          fill={SLICE_COLOURS[index % SLICE_COLOURS.length]}
                          stroke="transparent"
                          style={{ filter: `drop-shadow(0 0 5px ${SLICE_COLOURS[index % SLICE_COLOURS.length]}80)` }}
                        />
                      ))}
                    </Pie>
                    <Tooltip content={<PieTooltip />} />
                    <Legend
                      iconType="circle"
                      iconSize={8}
                      formatter={(value) =>
                        value.length > 22 ? value.slice(0, 20) + "…" : value
                      }
                      wrapperStyle={{ fontSize: "0.72rem", color: "#3d7a3d" }}
                    />
                  </PieChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <div
                className="d-flex align-items-center justify-content-center chart-container"
                style={{ color: "#3d7a3d", fontSize: "0.8rem" }}
              >
                [ no allocation data ]
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── P&L over time ──────────────────────────────────────── */}
      <div className="col-12 col-lg-7">
        <div className="hk-card h-100">
          <div className="hk-card-header">Cumulative P&amp;L</div>
          <div className="card-body p-2">
            {hasPnl ? (
              <div className="chart-container">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart
                    data={pnlData}
                    margin={{ top: 10, right: 16, left: 0, bottom: 4 }}
                  >
                    <defs>
                      <linearGradient id="pnl-grad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%"  stopColor="#00ff41" stopOpacity={0.3} />
                        <stop offset="95%" stopColor="#00ff41" stopOpacity={0.02} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="#1c3c1c" />
                    <XAxis
                      dataKey="time"
                      tick={{ fill: "#3d7a3d", fontSize: 10 }}
                      tickLine={false}
                      axisLine={{ stroke: "#1c3c1c" }}
                      interval="preserveStartEnd"
                    />
                    <YAxis
                      tick={{ fill: "#3d7a3d", fontSize: 10 }}
                      tickLine={false}
                      axisLine={{ stroke: "#1c3c1c" }}
                      tickFormatter={(v: number) => `$${v.toFixed(2)}`}
                      domain={[minPnl - pnlPadding, maxPnl + pnlPadding]}
                      width={55}
                    />
                    <Tooltip content={<PnlTooltip />} />
                    <Area
                      type="monotone"
                      dataKey="pnl"
                      stroke="#00ff41"
                      strokeWidth={2}
                      fill="url(#pnl-grad)"
                      dot={false}
                      activeDot={{ r: 4, fill: "#00ff41", stroke: "#0c1210", strokeWidth: 2 }}
                      style={{ filter: "drop-shadow(0 0 4px rgba(0,255,65,0.5))" }}
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <div
                className="d-flex align-items-center justify-content-center chart-container"
                style={{ color: "#3d7a3d", fontSize: "0.8rem" }}
              >
                [ no closed positions yet — P&amp;L chart will populate as trades close ]
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
