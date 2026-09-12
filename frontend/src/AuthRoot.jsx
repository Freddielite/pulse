import { useState } from "react";
import { login, signup, verifyLoginTotp } from "./api.js";

export default function AuthRoot({ onAuthed }) {
  const [mode, setMode] = useState("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [signupCode, setSignupCode] = useState("");
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  // Set once password auth succeeds but the account has 2FA on - the
  // form below swaps to asking for a code instead of starting over.
  const [awaitingTotp, setAwaitingTotp] = useState(false);
  const [totpCode, setTotpCode] = useState("");
  const [useBackupCode, setUseBackupCode] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const result = mode === "login"
        ? await login({ email, password })
        : await signup({ email, password, signup_code: signupCode });
      if (result.requires_totp) {
        setAwaitingTotp(true);
      } else {
        onAuthed(result);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleVerifyTotp(e) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const user = await verifyLoginTotp(
        useBackupCode ? { backup_code: totpCode } : { code: totpCode }
      );
      onAuthed(user);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

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
        <div className="pl-auth__tagline">Uptime and keep-alive monitoring for what you've built.</div>

        {awaitingTotp ? (
          <form onSubmit={handleVerifyTotp}>
            <div className="pl-field">
              <label>{useBackupCode ? "Backup code" : "6-digit code from your authenticator app"}</label>
              <input
                value={totpCode}
                onChange={(e) => setTotpCode(e.target.value)}
                inputMode={useBackupCode ? "text" : "numeric"}
                autoFocus
                required
              />
            </div>
            {error && <div className="pl-error">{error}</div>}
            <button className="pl-btn" type="submit" disabled={busy} style={{ width: "100%" }}>
              {busy ? "Verifying..." : "Verify"}
            </button>
            <div className="pl-auth__switch">
              <button type="button" onClick={() => { setUseBackupCode((v) => !v); setTotpCode(""); setError(null); }}>
                {useBackupCode ? "Use authenticator code instead" : "Use a backup code instead"}
              </button>
            </div>
          </form>
        ) : (
          <>
            <form onSubmit={handleSubmit}>
              <div className="pl-field">
                <label>Email</label>
                <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
              </div>
              <div className="pl-field">
                <label>Password</label>
                <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} />
              </div>
              {mode === "signup" && (
                <div className="pl-field">
                  <label>Signup code (if one was given to you)</label>
                  <input type="text" value={signupCode} onChange={(e) => setSignupCode(e.target.value)} />
                </div>
              )}
              {error && <div className="pl-error">{error}</div>}
              <button className="pl-btn" type="submit" disabled={busy} style={{ width: "100%" }}>
                {busy ? "Working..." : mode === "login" ? "Log in" : "Create account"}
              </button>
            </form>

            <div className="pl-auth__switch">
              {mode === "login" ? (
                <>No account yet? <button onClick={() => setMode("signup")}>Sign up</button></>
              ) : (
                <>Already have an account? <button onClick={() => setMode("login")}>Log in</button></>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
