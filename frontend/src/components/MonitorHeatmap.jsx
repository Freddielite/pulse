// Categorical, not a gradient: matches the same green/amber/red language
// used for latency elsewhere in the app (see MonitorCard's latencyColor)
// rather than introducing a fourth, unrelated color scale just for this.
function cellColor(pct) {
  if (pct == null) return "rgba(255, 255, 255, 0.05)";
  if (pct >= 100) return "#3ddc84";
  if (pct >= 50) return "#ffb84d";
  return "#ff5d5d";
}

function toDateKey(d) {
  return d.toISOString().slice(0, 10);
}

export default function MonitorHeatmap({ dailyData, createdAt, days = 90 }) {
  const byDate = Object.fromEntries(dailyData.map((d) => [d.date, d]));

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Don't pad the grid back further than the monitor has actually
  // existed - a monitor added a few hours ago showing 90 columns of
  // empty gray (with its one real day buried off-screen to the right)
  // reads as broken, not as "not enough history yet".
  const earliestPossible = new Date(today);
  earliestPossible.setDate(earliestPossible.getDate() - (days - 1));
  let start = earliestPossible;
  if (createdAt) {
    const created = new Date(createdAt);
    created.setHours(0, 0, 0, 0);
    if (created > earliestPossible) start = created;
  }

  const daysToRender = Math.round((today - start) / (24 * 60 * 60 * 1000)) + 1;
  // Pad the front of the grid so columns line up as calendar weeks
  // (Sun-Sat rows), the way GitHub's contribution graph does, rather
  // than an arbitrary run of cells with no weekday alignment.
  const startDow = start.getDay();

  const cells = [];
  for (let i = 0; i < startDow; i++) cells.push(null);
  for (let i = 0; i < daysToRender; i++) {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    const key = toDateKey(d);
    cells.push({ date: key, entry: byDate[key] || null });
  }

  return (
    <div className="pl-heatmap">
      {cells.map((cell, idx) => (
        <div
          key={idx}
          className="pl-heatmap__cell"
          style={{ background: cell ? cellColor(cell.entry?.uptime_pct ?? null) : "transparent" }}
          title={
            cell
              ? cell.entry
                ? `${cell.date}: ${cell.entry.uptime_pct}% (${cell.entry.total_checks} checks)`
                : `${cell.date}: no data`
              : undefined
          }
        />
      ))}
    </div>
  );
}
