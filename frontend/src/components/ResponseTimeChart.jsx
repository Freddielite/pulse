import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";
import { useIsMobile } from "../hooks/useIsMobile.js";
import { latencyColorForMs } from "../lib/latency.js";

// A raw point per check (as often as every minute or two, over up to 200
// checks) reads as jittery noise on a chart that's only ~300px wide on a
// phone - there's no room for that much detail to mean anything, it just
// looks like a spike-covered mess. Bucketing into at most maxPoints
// groups and averaging each one keeps the actual trend (rising latency,
// a slow patch) visible without every single sample fighting for pixels.
// null (down/no-data) points are dropped from the average rather than
// counted as 0ms, and a bucket that's all-null stays null so outages
// still show as a real gap in the line, not a dip to zero.
function downsampleChartData(data, maxPoints) {
  if (data.length <= maxPoints) return data;
  const bucketSize = Math.ceil(data.length / maxPoints);
  const result = [];
  for (let i = 0; i < data.length; i += bucketSize) {
    const bucket = data.slice(i, i + bucketSize);
    const withMs = bucket.filter((d) => d.ms != null);
    const avgMs = withMs.length ? Math.round(withMs.reduce((sum, d) => sum + d.ms, 0) / withMs.length) : null;
    result.push({ time: bucket[bucket.length - 1].time, ms: avgMs });
  }
  return result;
}

// Custom tooltip content (rather than recharts' default + itemStyle) so
// the ms figure is colored by what that specific value actually means -
// the same green/amber/red bands used everywhere else latency shows up -
// instead of always inheriting the line's fixed green regardless of
// whether that point was fast or slow.
function ResponseTimeTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background: "#0e1512", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 8, fontSize: 12, padding: "8px 10px" }}>
      <div style={{ color: "var(--ink-dim)", marginBottom: 2 }}>{label}</div>
      <div style={{ color: latencyColorForMs(payload[0].value), fontWeight: 600 }}>
        {payload[0].value != null ? `ms : ${payload[0].value}` : "no data"}
      </div>
    </div>
  );
}

// Renders the "Response time" section label + panel. Takes raw checks
// ({ checked_at, status, response_ms }[]) rather than pre-built chart
// points, so both the owner's full check log and the public share
// view's narrowed-down /checks response can feed it directly.
export default function ResponseTimeChart({ checks }) {
  const isMobile = useIsMobile();

  const rawChartData = checks.map((c) => ({
    time: new Date(c.checked_at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }),
    ms: c.status === "up" ? c.response_ms : null,
  }));
  // Narrower screens get fewer buckets - there's simply less width for
  // points to occupy before they start overlapping into noise.
  const chartData = downsampleChartData(rawChartData, isMobile ? 24 : 60);

  return (
    <>
      <div className="pl-section-label">Response time</div>
      <div className="pl-panel" style={{ height: isMobile ? 170 : 200, padding: isMobile ? "14px 4px 6px" : "16px 10px 6px" }}>
        {chartData.length > 1 ? (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chartData} margin={{ left: isMobile ? -12 : 0 }}>
              <CartesianGrid stroke="rgba(255,255,255,0.06)" vertical={false} />
              <XAxis dataKey="time" tick={{ fontSize: 10, fill: "var(--ink-faint)" }} axisLine={false} tickLine={false} minTickGap={isMobile ? 24 : 40} />
              <YAxis tick={{ fontSize: 10, fill: "var(--ink-faint)" }} axisLine={false} tickLine={false} unit="ms" width={isMobile ? 36 : 44} />
              <Tooltip content={<ResponseTimeTooltip />} />
              <Line type="monotone" dataKey="ms" stroke="#3ddc84" strokeWidth={1.75} dot={false} connectNulls={false} />
            </LineChart>
          </ResponsiveContainer>
        ) : (
          <div style={{ color: "var(--ink-dim)", fontSize: 13, textAlign: "center", paddingTop: 70 }}>
            Not enough checks yet to plot a trend.
          </div>
        )}
      </div>
    </>
  );
}
