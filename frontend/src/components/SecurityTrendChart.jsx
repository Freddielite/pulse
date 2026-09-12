import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";
import { useIsMobile } from "../hooks/useIsMobile.js";

// Same green/amber/red band a grade already implies elsewhere in the
// app (SecurityScanPanel's severity colors), applied here to the score
// line itself so a glance at color alone roughly tracks "getting
// better" vs "getting worse" without reading the axis.
function colorForScore(score) {
  if (score == null) return "var(--ink-faint)";
  if (score >= 90) return "#3ddc84";
  if (score >= 75) return "#8bd450";
  if (score >= 60) return "#e6c74b";
  if (score >= 40) return "#e08a3c";
  return "#e5484d";
}

function ScoreTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  const point = payload[0].payload;
  return (
    <div style={{ background: "#0e1512", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 8, fontSize: 12, padding: "8px 10px" }}>
      <div style={{ color: "var(--ink-dim)", marginBottom: 2 }}>{label}</div>
      <div style={{ color: colorForScore(point.score), fontWeight: 600 }}>
        {point.score != null ? `${point.score}/100${point.grade ? ` (${point.grade})` : ""}` : "no data"}
      </div>
    </div>
  );
}

// Takes the same security_scans history rows the panel above already
// fetches ({ scanned_at, score, grade, summary }[]) - no separate
// endpoint needed, this is purely a different view of data the app was
// already pulling for the sparkline-style history it kept but never
// actually charted.
export default function SecurityTrendChart({ history }) {
  const isMobile = useIsMobile();
  const chartData = history
    .filter((h) => h.score != null)
    .map((h) => ({
      time: new Date(h.scanned_at).toLocaleDateString(undefined, { month: "short", day: "numeric" }),
      score: h.score,
      grade: h.grade,
    }));

  if (chartData.length < 2) return null; // one point (or none) isn't a trend - the panel above already shows the current score

  return (
    <>
      <div className="pl-section-label">Security score over time</div>
      <div className="pl-panel" style={{ height: isMobile ? 160 : 190, padding: isMobile ? "14px 4px 6px 0" : "16px 10px 6px" }}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={chartData} margin={{ top: 4, right: isMobile ? 4 : 8, left: 0, bottom: 0 }}>
            <CartesianGrid stroke="rgba(255,255,255,0.06)" vertical={false} />
            <XAxis dataKey="time" tick={{ fontSize: 10, fill: "var(--ink-faint)" }} axisLine={false} tickLine={false} minTickGap={isMobile ? 24 : 40} />
            <YAxis domain={[0, 100]} tick={{ fontSize: 10, fill: "var(--ink-faint)" }} axisLine={false} tickLine={false} width={isMobile ? 28 : 32} />
            <Tooltip content={<ScoreTooltip />} />
            <Line type="monotone" dataKey="score" stroke="#3ddc84" strokeWidth={1.75} dot={false} connectNulls={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </>
  );
}
