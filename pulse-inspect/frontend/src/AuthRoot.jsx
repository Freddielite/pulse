import { useState } from "react";
import { login, signup } from "./api.js";

export default function AuthRoot({ onAuthed }) {
  const [mode, setMode] = useState("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [signupCode, setSignupCode] = useState("");
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const user = mode === "login"
        ? await login({ email, password })
        : await signup({ email, password, signup_code: signupCode });
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
      </div>
    </div>
  );
}
