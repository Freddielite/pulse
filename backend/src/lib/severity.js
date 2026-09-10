// Severity model for security findings.
//
// The original scanner scored pass/total with every check weighted
// equally, which meant a publicly readable .env file and a missing
// Permissions-Policy header moved the number by exactly the same amount.
// That's the one thing that makes a security score untrustworthy: it
// stops tracking risk and starts tracking check count, so adding more
// cosmetic checks mechanically dilutes the serious ones.
//
// Weights are deliberately coarse (four real levels, roughly 3x apart).
// A finer scale would imply a precision this kind of passive, outside-in
// scan doesn't have.

export const SEVERITY = {
  CRITICAL: "critical",
  HIGH: "high",
  MEDIUM: "medium",
  LOW: "low",
  // INFO findings are reported but never scored - they're context
  // ("this site uses Cloudflare", "3 third-party scripts"), not pass/fail
  // judgments, and letting them into the score would move it around for
  // reasons that aren't better or worse security.
  INFO: "info",
};

const WEIGHTS = {
  [SEVERITY.CRITICAL]: 10,
  [SEVERITY.HIGH]: 6,
  [SEVERITY.MEDIUM]: 3,
  [SEVERITY.LOW]: 1,
  [SEVERITY.INFO]: 0,
};

export function weightFor(severity) {
  return WEIGHTS[severity] ?? WEIGHTS[SEVERITY.MEDIUM];
}

// Ordering for display and for "worst finding" summaries. Lower is worse.
const RANK = {
  [SEVERITY.CRITICAL]: 0,
  [SEVERITY.HIGH]: 1,
  [SEVERITY.MEDIUM]: 2,
  [SEVERITY.LOW]: 3,
  [SEVERITY.INFO]: 4,
};

export function severityRank(severity) {
  return RANK[severity] ?? RANK[SEVERITY.MEDIUM];
}

export function sortFindings(findings) {
  return [...findings].sort((a, b) => {
    // Failures first, then by severity, so the top of the list is always
    // the thing most worth doing something about.
    if (a.pass !== b.pass) return a.pass ? 1 : -1;
    return severityRank(a.severity) - severityRank(b.severity);
  });
}

// Weighted score: the share of at-risk weight that actually passed.
// A single critical failure costs ten times what a low one does, so the
// number moves when something that matters breaks and stays put when it
// doesn't.
export function scoreFindings(findings) {
  let possible = 0;
  let earned = 0;
  for (const finding of findings) {
    const weight = weightFor(finding.severity);
    if (weight === 0) continue;
    possible += weight;
    if (finding.pass) earned += weight;
  }
  if (possible === 0) return 100;
  return Math.round((earned / possible) * 100);
}

// A letter grade alongside the number, because "82/100" reads as fine
// while "B" reads as "there's something here" - and a critical failure
// should never present as a good grade regardless of how many trivial
// checks passed alongside it.
export function gradeFor(score, findings = []) {
  const hasCriticalFailure = findings.some((f) => !f.pass && f.severity === SEVERITY.CRITICAL);
  if (hasCriticalFailure) return "F";
  if (score >= 95) return "A+";
  if (score >= 90) return "A";
  if (score >= 80) return "B";
  if (score >= 70) return "C";
  if (score >= 55) return "D";
  return "F";
}

export function summarize(findings) {
  const counts = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const finding of findings) {
    if (!finding.pass) counts[finding.severity] = (counts[finding.severity] || 0) + 1;
  }
  return counts;
}
