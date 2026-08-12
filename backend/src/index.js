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

const app = express();

// Render sits behind a proxy that terminates TLS, so without this Express
// never sees the connection as "secure" and refuses to set secure cookies
// in production, silently breaking login.
app.set("trust proxy", 1);

const corsOrigin = process.env.CORS_ORIGIN || "*";
app.use(cors({ origin: corsOrigin, credentials: true }));
app.use(express.json());

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

const PORT = process.env.PORT || 4000;

migrate()
  .then(() => {
    app.listen(PORT, () => console.log(`Pulse backend listening on :${PORT}`));
  })
  .catch((err) => {
    console.error("Failed to migrate database:", err);
    process.exit(1);
  });
