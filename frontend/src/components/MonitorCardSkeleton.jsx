// Mirrors MonitorCard's actual layout (status dot, name line, two
// stats) so the loading state doesn't jump/reflow once real data
// swaps in - just the shimmering placeholders becoming real content
// in the same spots.
export default function MonitorCardSkeleton() {
  return (
    <div className="pl-panel pl-skeleton-card" aria-hidden="true">
      <div className="pl-skeleton pl-skeleton-card__dot" />
      <div className="pl-skeleton-card__lines">
        <div className="pl-skeleton" style={{ width: "55%", height: 13 }} />
        <div className="pl-skeleton" style={{ width: "35%", height: 10 }} />
      </div>
      <div style={{ display: "flex", gap: 18 }}>
        <div className="pl-skeleton" style={{ width: 36, height: 24 }} />
        <div className="pl-skeleton" style={{ width: 36, height: 24 }} />
      </div>
    </div>
  );
}
