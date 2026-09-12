import { useState } from "react";

function Row({ label, children, warn = false }) {
  return (
    <div className="pl-expiry-row">
      <span className="pl-expiry-row__label">{label}</span>
      <span style={{ color: warn ? "var(--alert)" : undefined, textAlign: "right", wordBreak: "break-word" }}>{children}</span>
    </div>
  );
}

function formatDate(iso) {
  if (!iso) return "unknown";
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

// ---------------------------------------------------------------------
// TLS
// ---------------------------------------------------------------------

export function TlsPanel({ monitor, tls }) {
  const posture = tls?.tls_posture;

  return (
    <>
      <div className="pl-section-label">Certificate &amp; TLS</div>
      <div className="pl-panel">
        <Row label="SSL certificate expires">{monitor.ssl_expires_at ? formatDate(monitor.ssl_expires_at) : "Not checked yet"}</Row>
        <Row label="Domain registration expires">
          {monitor.domain_expires_at ? formatDate(monitor.domain_expires_at) : "Unknown (best-effort lookup)"}
        </Row>
        {posture && (
          <>
            <Row label="Issued by">{posture.issuer || "unknown"}</Row>
            <Row label="Protocol" warn={/TLSv1(\.[01])?$/.test(posture.protocol || "")}>
              {posture.protocol || "unknown"}
              {posture.cipherName ? ` · ${posture.cipherName}` : ""}
            </Row>
            <Row label="Key">{posture.keyType ? `${posture.keyType}${posture.keyBits ? ` ${posture.keyBits}-bit` : ""}` : "unknown"}</Row>
            <Row label="Covers this hostname" warn={!posture.hostnameMatches}>
              {posture.hostnameMatches ? "Yes" : "No - name mismatch"}
            </Row>
            <Row label="Chain" warn={posture.chainLength <= 1}>
              {posture.chainLength > 1
                ? `${posture.chainLength} certificates sent`
                : "Leaf only - no intermediates (breaks curl, Java, Android)"}
            </Row>
            <Row label="Trusted" warn={!posture.authorized}>
              {posture.authorized ? "Validates against the trust store" : posture.authorizationError || "Does not validate"}
            </Row>
            {/* The fingerprint is here mostly so it can be eyeballed
                against what the browser reports during an incident. */}
            <Row label="Fingerprint (SHA-256)">
              <code style={{ fontSize: 10.5, fontFamily: "var(--font-mono)", color: "var(--ink-dim)" }}>
                {posture.fingerprint256 || "unknown"}
              </code>
            </Row>
          </>
        )}
        {tls?.cert_check_error && (
          <div style={{ fontSize: 11.5, color: "var(--amber)", marginTop: 8 }}>{tls.cert_check_error}</div>
        )}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------
// DNS
// ---------------------------------------------------------------------

const RECORD_ROWS = [
  { key: "a", label: "A (IPv4)" },
  { key: "aaaa", label: "AAAA (IPv6)" },
  { key: "cname", label: "CNAME" },
  { key: "ns", label: "Nameservers" },
  { key: "mx", label: "MX (mail)" },
];

export function DnsPanel({ dns, onRefresh, refreshing, canManage = true }) {
  const snapshot = dns?.dns_snapshot;

  const spf = snapshot?.txt?.find((record) => /^v=spf1/i.test(record));
  const dmarc = snapshot?.dmarc?.find((record) => /^v=DMARC1/i.test(record));
  const dmarcPolicy = dmarc?.match(/\bp\s*=\s*(none|quarantine|reject)/i)?.[1]?.toLowerCase();
  const unresolved = snapshot?.unresolved || {};

  return (
    <>
      <div
        className="pl-section-label"
        style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "6px 8px" }}
      >
        <span>DNS</span>
        {canManage && (
          <button
            type="button"
            className="pl-btn pl-btn--ghost"
            style={{ fontSize: 11, padding: "3px 10px" }}
            onClick={onRefresh}
            disabled={refreshing}
          >
            {refreshing ? "Checking…" : "Check now"}
          </button>
        )}
      </div>
      <div className="pl-panel">
        {!snapshot ? (
          <div style={{ color: "var(--ink-dim)", fontSize: 13 }}>
            Not checked yet. Runs automatically every few hours - Pulse records the records and alerts if they change
            when you didn't change them.
          </div>
        ) : (
          <>
            {RECORD_ROWS.filter((row) => snapshot[row.key]?.length > 0).map((row) => (
              <Row key={row.key} label={row.label}>
                {snapshot[row.key].join(", ")}
              </Row>
            ))}
            {/* "Couldn't look it up" is shown as exactly that rather than
                as "not configured" - the two mean very different things
                and conflating them is how a scanner tells a confident
                lie about a correctly configured domain. */}
            <Row label="SPF" warn={!spf && !unresolved.txt}>
              {unresolved.txt ? "Lookup failed - unknown" : spf ? "Published" : "Not published"}
            </Row>
            <Row label="DMARC" warn={!unresolved.dmarc && (!dmarc || dmarcPolicy === "none")}>
              {unresolved.dmarc
                ? "Lookup failed - unknown"
                : dmarc
                  ? `p=${dmarcPolicy || "unset"}${dmarcPolicy === "none" ? " (monitor only)" : ""}`
                  : "Not published"}
            </Row>
            <Row label="CAA" warn={!unresolved.caa && (snapshot.caa?.length ?? 0) === 0}>
              {unresolved.caa ? "Lookup failed - unknown" : snapshot.caa?.length > 0 ? `${snapshot.caa.length} record(s)` : "None - any CA may issue"}
            </Row>
            {dns?.dns_checked_at && (
              <div style={{ fontSize: 11.5, color: "var(--ink-faint)", marginTop: 8 }}>
                Last checked {new Date(dns.dns_checked_at).toLocaleString()}
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------
// Certificate Transparency
// ---------------------------------------------------------------------

export function CertificatesPanel({ data, onRefresh, refreshing, onMonitorSubdomain, canManage = true }) {
  const [showAll, setShowAll] = useState(false);
  const certificates = data?.certificates || [];
  const subdomains = data?.subdomains || [];
  const unmonitored = subdomains.filter((entry) => !entry.monitored);
  const visible = showAll ? subdomains : subdomains.slice(0, 8);

  return (
    <>
      <div
        className="pl-section-label"
        style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "6px 8px" }}
      >
        <span>Certificate transparency</span>
        {canManage && (
          <button
            type="button"
            className="pl-btn pl-btn--ghost"
            style={{ fontSize: 11, padding: "3px 10px" }}
            onClick={onRefresh}
            disabled={refreshing}
          >
            {refreshing ? "Checking crt.sh…" : "Check now"}
          </button>
        )}
      </div>
      <div className="pl-panel">
        {certificates.length === 0 ? (
          <div style={{ color: "var(--ink-dim)", fontSize: 13 }}>
            Not checked yet. Pulse reads the public Certificate Transparency logs for this domain, alerts if a
            certificate is issued that you didn't expect, and lists every subdomain anyone has ever requested a
            certificate for.
          </div>
        ) : (
          <>
            <div style={{ fontSize: 12, color: "var(--ink-dim)", marginBottom: 10 }}>
              {certificates.length} live certificate{certificates.length === 1 ? "" : "s"} · {subdomains.length} hostname
              {subdomains.length === 1 ? "" : "s"} seen
              {unmonitored.length > 0 && (
                <>
                  {" · "}
                  <span style={{ color: "var(--amber)" }}>{unmonitored.length} not monitored</span>
                </>
              )}
            </div>

            {visible.map((entry) => (
              <div key={entry.hostname} className="pl-expiry-row">
                <span className="pl-expiry-row__label" style={{ wordBreak: "break-all" }}>
                  {entry.hostname}
                </span>
                {entry.monitored ? (
                  <span style={{ fontSize: 11.5, color: "var(--signal)" }}>Monitored</span>
                ) : (
                  <button
                    type="button"
                    className="pl-btn pl-btn--ghost"
                    style={{ fontSize: 10.5, padding: "2px 8px", flexShrink: 0 }}
                    onClick={() => onMonitorSubdomain(entry.hostname)}
                  >
                    Monitor this
                  </button>
                )}
              </div>
            ))}

            {subdomains.length > 8 && (
              <button
                type="button"
                className="pl-btn pl-btn--ghost"
                style={{ fontSize: 11, padding: "3px 10px", marginTop: 8 }}
                onClick={() => setShowAll(!showAll)}
              >
                {showAll ? "Show fewer" : `Show all ${subdomains.length}`}
              </button>
            )}
          </>
        )}
      </div>
    </>
  );
}
