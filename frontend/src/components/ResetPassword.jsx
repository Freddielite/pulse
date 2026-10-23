import { useState } from "react";
import { resetPassword } from "../api.js";

// Rendered from main.jsx for #/reset-password?token=... Same pattern as
// VerifyEmail: nothing happens on load, only on an explicit submit, so a
// mail client prefetching the link cannot burn the single-use token.
export default function ResetPassword({ token }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    if (password !== confirm) {
      setError("Passwords don't match.");
      return;
    }
    setBusy(true);
    try {
      await resetPassword(token, password);
      setDone(true);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="pl-auth">
      <div className="pl-panel pl-auth__card">
        <div className="pl-auth__brand">Pulse</div>
        {done ? (
          <>
            <div className="pl-auth__tagline">Password changed. All other sessions were signed out.</div>
            <a className="pl-btn" href={window.location.pathname} style={{ width: "100%", textAlign: "center", display: "block", textDecoration: "none", boxSizing: "border-box" }}>
              Log in
            </a>
          </>
        ) : (
          <form onSubmit={handleSubmit}>
            <div className="pl-auth__tagline">Choose a new password.</div>
            <div className="pl-field">
              <label>New password</label>
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} autoFocus />
            </div>
            <div className="pl-field">
              <label>Confirm password</label>
              <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required minLength={8} />
            </div>
            {error && <div className="pl-error">{error}</div>}
            <button className="pl-btn" type="submit" disabled={busy} style={{ width: "100%" }}>
              {busy ? "Saving..." : "Set new password"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
