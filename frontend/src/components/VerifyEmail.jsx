import { useEffect, useState } from "react";
import { verifyEmail } from "../api.js";

// Rendered from main.jsx in place of the whole app when the URL is a
// confirmation link (#/verify-email?token=...) - same reasoning as
// SharedMonitorView/SharedStatusPageView being routed before App ever
// mounts, just for the opposite direction: this one is *establishing* a
// session rather than deliberately avoiding one.
//
// On success, this doesn't try to hand a user object to App via props -
// there's no clean way to do that from outside App's own tree. Instead
// it clears the URL back to plain "/" and reloads: the confirmation
// POST already set the session cookie server-side, so App's own
// getMe() on that fresh mount picks it up and shows the authed app
// directly, the same as a normal login would have.
export default function VerifyEmail({ token }) {
  const [status, setStatus] = useState("verifying"); // verifying | error
  const [error, setError] = useState(null);

  useEffect(() => {
    let ignore = false;
    verifyEmail(token)
      .then(() => {
        if (ignore) return;
        window.location.href = window.location.pathname;
      })
      .catch((err) => {
        if (ignore) return;
        setError(err.message);
        setStatus("error");
      });
    return () => {
      ignore = true;
    };
  }, [token]);

  return (
    <div className="pl-auth">
      <div className="pl-panel pl-auth__card">
        <div className="pl-auth__brand">
          <svg width="24" height="24" viewBox="0 0 100 100">
            <rect width="100" height="100" rx="20" fill="#0a0f0d" />
            <path d="M8 50 H32 L40 28 L54 72 L64 50 H92" fill="none" stroke="#3ddc84" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Pulse
        </div>
        {status === "verifying" ? (
          <div className="pl-auth__tagline">Confirming your account...</div>
        ) : (
          <>
            <div className="pl-error">{error}</div>
            <a className="pl-btn" href={window.location.pathname} style={{ width: "100%", textAlign: "center", display: "block", textDecoration: "none", boxSizing: "border-box" }}>
              Back to sign up
            </a>
          </>
        )}
      </div>
    </div>
  );
}
