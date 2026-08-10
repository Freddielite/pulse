// Thresholds are deliberately generous for a personal-app use case (most
// of what's being watched here is a small Render/Vercel backend, not a
// latency-sensitive trading API): comfortably fast, tolerably slow, and
// "something's actually wrong" - not fine-grained percentile bands.
// Shared so a given ms value reads the same color everywhere it shows up
// (monitor card stat, response-time chart tooltip, anywhere else later)
// instead of each place inventing its own cutoffs.
export function latencyColorForMs(ms) {
  if (ms == null) return "var(--ink)";
  if (ms < 300) return "var(--signal)";
  if (ms < 1500) return "var(--amber)";
  return "var(--alert)";
}
