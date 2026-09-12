import "dotenv/config";
import express from "express";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import cors from "cors";
import { pool, migrate } from "./db.js";
import authRouter from "./routes/auth.js";
import monitorsRouter from "./routes/monitors.js";
import pushRouter from "./routes/push.js";
import cronRouter from "./routes/cron.js";
import telegramRouter from "./routes/telegram.js";
import tokensRouter from "./routes/tokens.js";
import statusPagesRouter from "./routes/statusPages.js";
import publicRouter from "./routes/public.js";
import organizationsRouter from "./routes/organizations.js";
import { securityHeaders } from "./middleware/securityHeaders.js";

const app = express();

// Render sits behind a proxy that terminates TLS, so without this Express
// never sees the connection as "secure" and refuses to set secure cookies
// in production, silently breaking login.
app.set("trust proxy", 1);

// Express advertises itself in X-Powered-By by default, which is exactly
// the version-disclosure finding lib/scanner.js reports on other people's
// sites.
app.disable("x-powered-by");

const corsOrigin = process.env.CORS_ORIGIN || "*";
app.use(cors({ origin: corsOrigin, credentials: true }));
// Applied before every route, including the public and error paths, so
// there's no response shape that escapes them.
app.use(securityHeaders());
// A body limit, because the default (100kb) is generous for an API whose
// largest legitimate payload is a monitor with a handful of synthetic
// steps, and an unbounded parse is free memory pressure on a free-tier
// box.
// Org branding (PATCH /api/organizations/:id) can carry a base64-encoded
// logo image - comfortably past that 64kb ceiling, which is sized for
// every other endpoint's actual payloads. Registered first so it wins
// for matching paths; body-parser marks the body as already parsed once
// this runs, so the stricter global limit below just passes it through
// rather than re-parsing (and re-rejecting) it.
app.use("/api/organizations", express.json({ limit: "1mb" }));
app.use(express.json({ limit: "64kb" }));

const PgSession = connectPgSimple(session);
app.use(
  session({
    store: new PgSession({ pool, createTableIfMissing: true }),
    secret: process.env.SESSION_SECRET || "dev-only-secret-change-me",
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: 1000 * 60 * 60 * 24 * 30,
      httpOnly: true,
      // Cross-site cookies (Vercel frontend + Render backend) need
      // sameSite: "none", which browsers only honor over HTTPS, hence
      // gating both on NODE_ENV instead of hardcoding for prod.
      secure: process.env.NODE_ENV === "production",
      sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
    },
  })
);

app.get("/api/health", (req, res) => res.json({ ok: true }));

app.use("/api/auth", authRouter);
app.use("/api/monitors", monitorsRouter);
app.use("/api/push", pushRouter);
app.use("/api/cron", cronRouter);
app.use("/api/telegram", telegramRouter);
app.use("/api/tokens", tokensRouter);
app.use("/api/status-pages", statusPagesRouter);
app.use("/api/public", publicRouter);
app.use("/api/organizations", organizationsRouter);

const PORT = process.env.PORT || 4000;

migrate()
  .then(() => {
    app.listen(PORT, () => console.log(`Pulse backend listening on :${PORT}`));
  })
  .catch((err) => {
    console.error("Failed to migrate database:", err);
    process.exit(1);
  });
