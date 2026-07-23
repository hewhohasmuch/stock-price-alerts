import express from "express";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import { randomUUID } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  initDb, pool, checkRateLimit,
  listAlerts, addAlert, addTypedAlert, getAlert, removeAlert, setAlertEnabled,
  updateAlertNotes, updateAlertThresholds, updateAlertParams, resetBreach,
  setAlertShortlisted, setAlertStaged, updateAlertShares,
  resetTypedTrigger, createUser, verifyUser,
  findUserById, updateUserNotificationEmail,
} from "./db.js";
import type { AlertParams, AlertType, PercentChangeParams } from "./types.js";
import { fetchSinglePrice, fetchPrices } from "./services/price-fetcher.js";
import { checkPrices } from "./scheduler.js";
import { isMarketOpen } from "./utils/market-hours.js";

declare module "express-session" {
  interface SessionData {
    userId: string;
    username: string;
  }
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT) || 3000;
const isProduction = process.env.NODE_ENV === "production";

// ── Session secret validation ────────────────────────────────────────────
const sessionSecret = process.env.SESSION_SECRET;
if (isProduction && !sessionSecret) {
  throw new Error("SESSION_SECRET environment variable is required in production. Generate with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"");
}
if (!sessionSecret) {
  console.warn("WARNING: SESSION_SECRET is not set. Using a random secret — sessions will not survive restarts.");
}
const resolvedSecret = sessionSecret || randomUUID();

// ── Trust proxy (must precede session so req.ip and secure cookies work) ─
if (isProduction) {
  app.set("trust proxy", 1);
}

// ── PostgreSQL session store ─────────────────────────────────────────────
const PgStore = connectPgSimple(session);

app.use(express.json());

app.use(
  session({
    store: new PgStore({
      pool,
      createTableIfMissing: true,
    }),
    secret: resolvedSecret,
    resave: false,
    saveUninitialized: false,
    name: "sid",
    cookie: {
      httpOnly: true,
      sameSite: "strict",
      secure: isProduction,
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    },
  })
);

app.use(express.static(join(__dirname, "..", "public")));

// ── Lazy DB initialization (serverless-safe, runs once on first request) ──
let dbInitPromise: Promise<void> | null = null;
app.use((_req, _res, next) => {
  if (!dbInitPromise) {
    dbInitPromise = initDb().catch((err) => {
      dbInitPromise = null; // allow retry on next request
      throw err;
    });
  }
  dbInitPromise.then(() => next()).catch(next);
});

// ── Rate limiting for auth endpoints ─────────────────────────────────────

async function rateLimitAuth(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
) {
  try {
    const ip = req.ip || "unknown";
    const result = await checkRateLimit(ip);
    if (!result.allowed) {
      res.status(429).json({
        error: "Too many attempts. Please try again later.",
        retryAfterSeconds: result.retryAfterSeconds,
      });
      return;
    }
    next();
  } catch (err) {
    console.error("Rate limit check failed:", (err as Error).message);
    res.status(503).json({ error: "Service temporarily unavailable. Please try again later." });
  }
}

// ── Health check (public, used by keep-alive ping) ──────────────────────
app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

// ── Auth routes ─────────────────────────────────────────────────────────

app.post("/api/auth/register", rateLimitAuth, async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      res.status(400).json({ error: "username and password required" });
      return;
    }
    if (username.length < 3 || username.length > 30) {
      res.status(400).json({ error: "Username must be 3-30 characters" });
      return;
    }
    if (password.length < 6) {
      res.status(400).json({ error: "Password must be at least 6 characters" });
      return;
    }
    const user = await createUser(username, password);
    req.session.userId = user.id;
    req.session.username = user.username;
    res.status(201).json({ id: user.id, username: user.username });
  } catch (err) {
    const msg = (err as Error).message;
    if (msg === "Username already taken") {
      res.status(409).json({ error: msg });
      return;
    }
    console.error("POST /api/auth/register error:", err);
    res.status(500).json({ error: "Registration failed" });
  }
});

app.post("/api/auth/login", rateLimitAuth, async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      res.status(400).json({ error: "username and password required" });
      return;
    }
    const user = await verifyUser(username, password);
    if (!user) {
      res.status(401).json({ error: "Invalid username or password" });
      return;
    }
    req.session.userId = user.id;
    req.session.username = user.username;
    res.json({ id: user.id, username: user.username });
  } catch (err) {
    console.error("POST /api/auth/login error:", err);
    res.status(500).json({ error: "Login failed" });
  }
});

app.post("/api/auth/logout", (req, res) => {
  req.session.destroy(() => {
    res.json({ ok: true });
  });
});

app.get("/api/auth/me", async (req, res) => {
  if (!req.session.userId) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  try {
    const user = await findUserById(req.session.userId);
    res.json({
      id: req.session.userId,
      username: req.session.username,
      notificationEmail: user?.notificationEmail ?? null,
    });
  } catch (err) {
    console.error("GET /api/auth/me error:", err);
    res.status(500).json({ error: "Failed to fetch user" });
  }
});

// ── Settings routes ─────────────────────────────────────────────────────

app.patch("/api/settings/email", async (req, res) => {
  if (!req.session.userId) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  try {
    const { email } = req.body;
    if (typeof email !== "string" || !email.trim()) {
      res.status(400).json({ error: "email is required" });
      return;
    }
    const trimmed = email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      res.status(400).json({ error: "Invalid email address" });
      return;
    }
    await updateUserNotificationEmail(req.session.userId, trimmed);
    res.json({ ok: true });
  } catch (err) {
    console.error("PATCH /api/settings/email error:", err);
    res.status(500).json({ error: "Failed to update email" });
  }
});

// ── Auth middleware ──────────────────────────────────────────────────────

function requireAuth(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
) {
  if (!req.session.userId) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  next();
}

// ── Typed alert param validation ─────────────────────────────────────────

const PERCENT_DIRECTIONS = ["up", "down", "either"] as const;

function validateAlertParams(
  alertType: string,
  params: unknown,
): { params: AlertParams } | { error: string } {
  const p = params as Record<string, unknown> | null | undefined;
  const percent = Number(p?.percent);
  if (!p || !Number.isFinite(percent) || percent <= 0 || percent > 100) {
    return { error: "params.percent must be a number between 0 and 100" };
  }

  if (alertType === "percent-change") {
    const direction = p.direction;
    if (typeof direction !== "string" || !PERCENT_DIRECTIONS.includes(direction as any)) {
      return { error: "params.direction must be 'up', 'down', or 'either'" };
    }
    return { params: { percent, direction } as PercentChangeParams };
  }

  if (alertType === "trailing-high") {
    return { params: { percent } };
  }

  return { error: `Unknown alertType '${alertType}'` };
}

// ── Alert routes (protected) ────────────────────────────────────────────

app.get("/api/alerts", requireAuth, async (req, res) => {
  try {
    const alerts = await listAlerts(req.session.userId!);
    res.json(alerts);
  } catch (err) {
    res.status(500).json({ error: "Failed to list alerts" });
  }
});

app.post("/api/alerts", requireAuth, async (req, res) => {
  try {
    const { symbol, abovePrice, belowPrice, notes, alertType, params } = req.body;
    if (!symbol) {
      res.status(400).json({ error: "symbol required" });
      return;
    }

    const isTyped = alertType != null && alertType !== "absolute-threshold";
    let typedParams: AlertParams | null = null;
    if (isTyped) {
      const validated = validateAlertParams(String(alertType), params);
      if ("error" in validated) {
        res.status(400).json({ error: validated.error });
        return;
      }
      typedParams = validated.params;
    } else if (abovePrice == null && belowPrice == null) {
      res
        .status(400)
        .json({ error: "symbol and at least one of abovePrice/belowPrice required" });
      return;
    }

    let resolvedSymbol = symbol.toUpperCase();
    let resolvedName = resolvedSymbol;
    try {
      const priceResult = await fetchSinglePrice(symbol);
      if (priceResult) {
        resolvedSymbol = priceResult.symbol;
        resolvedName = priceResult.name;
      }
    } catch (pfErr) {
      console.warn(`  Price lookup for ${symbol} failed:`, (pfErr as Error).message);
    }

    const trimmedNotes = notes ? String(notes).slice(0, 50) : undefined;
    const alert = typedParams
      ? await addTypedAlert(
          req.session.userId!,
          resolvedSymbol,
          resolvedName,
          alertType as AlertType,
          typedParams,
          trimmedNotes
        )
      : await addAlert(
          req.session.userId!,
          resolvedSymbol,
          resolvedName,
          abovePrice != null ? Number(abovePrice) : undefined,
          belowPrice != null ? Number(belowPrice) : undefined,
          trimmedNotes
        );
    res.status(201).json(alert);
  } catch (err) {
    console.error("POST /api/alerts error:", err);
    res.status(500).json({ error: "Failed to create alert" });
  }
});

app.delete("/api/alerts/:id", requireAuth, async (req, res) => {
  try {
    const removed = await removeAlert(String(req.params.id), req.session.userId!);
    if (!removed) {
      res.status(404).json({ error: "Alert not found" });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to remove alert" });
  }
});

app.patch("/api/alerts/:id/enable", requireAuth, async (req, res) => {
  try {
    const ok = await setAlertEnabled(String(req.params.id), req.session.userId!, true);
    if (!ok) {
      res.status(404).json({ error: "Alert not found" });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to enable alert" });
  }
});

app.patch("/api/alerts/:id/disable", requireAuth, async (req, res) => {
  try {
    const ok = await setAlertEnabled(String(req.params.id), req.session.userId!, false);
    if (!ok) {
      res.status(404).json({ error: "Alert not found" });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to disable alert" });
  }
});

app.patch("/api/alerts/:id/shortlist", requireAuth, async (req, res) => {
  try {
    const ok = await setAlertShortlisted(String(req.params.id), req.session.userId!, true);
    if (!ok) {
      res.status(404).json({ error: "Alert not found" });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to add to shortlist" });
  }
});

app.patch("/api/alerts/:id/unshortlist", requireAuth, async (req, res) => {
  try {
    const ok = await setAlertShortlisted(String(req.params.id), req.session.userId!, false);
    if (!ok) {
      res.status(404).json({ error: "Alert not found" });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to remove from shortlist" });
  }
});

app.patch("/api/alerts/:id/notes", requireAuth, async (req, res) => {
  try {
    const { notes } = req.body;
    if (typeof notes !== "string") {
      res.status(400).json({ error: "notes must be a string" });
      return;
    }
    const trimmed = notes.slice(0, 50);
    const ok = await updateAlertNotes(String(req.params.id), req.session.userId!, trimmed);
    if (!ok) {
      res.status(404).json({ error: "Alert not found" });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to update notes" });
  }
});

app.patch("/api/alerts/:id/shares", requireAuth, async (req, res) => {
  try {
    const shares = Number(req.body.shares);
    if (!Number.isFinite(shares) || shares < 0) {
      res.status(400).json({ error: "shares must be a non-negative number" });
      return;
    }
    const ok = await updateAlertShares(String(req.params.id), req.session.userId!, shares);
    if (!ok) {
      res.status(404).json({ error: "Alert not found" });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to update shares" });
  }
});

app.patch("/api/alerts/:id/stage", requireAuth, async (req, res) => {
  try {
    const { staged } = req.body;
    if (typeof staged !== "boolean") {
      res.status(400).json({ error: "staged must be a boolean" });
      return;
    }
    const ok = await setAlertStaged(String(req.params.id), req.session.userId!, staged);
    if (!ok) {
      res.status(404).json({ error: "Alert not found" });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to update stage" });
  }
});

app.patch("/api/alerts/:id/thresholds", requireAuth, async (req, res) => {
  try {
    const { abovePrice, belowPrice } = req.body;
    if (abovePrice == null && belowPrice == null) {
      res.status(400).json({ error: "At least one of abovePrice or belowPrice required" });
      return;
    }
    const above = abovePrice != null ? Number(abovePrice) : undefined;
    const below = belowPrice != null ? Number(belowPrice) : undefined;
    if ((above != null && isNaN(above)) || (below != null && isNaN(below))) {
      res.status(400).json({ error: "Prices must be valid numbers" });
      return;
    }
    const ok = await updateAlertThresholds(String(req.params.id), req.session.userId!, above, below);
    if (!ok) {
      res.status(404).json({ error: "Alert not found" });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to update thresholds" });
  }
});

app.patch("/api/alerts/:id/params", requireAuth, async (req, res) => {
  try {
    const alert = await getAlert(String(req.params.id), req.session.userId!);
    if (!alert) {
      res.status(404).json({ error: "Alert not found" });
      return;
    }
    if (!alert.alertType) {
      res.status(400).json({ error: "Use /thresholds to edit this alert" });
      return;
    }
    const validated = validateAlertParams(alert.alertType, req.body?.params ?? req.body);
    if ("error" in validated) {
      res.status(400).json({ error: validated.error });
      return;
    }
    const ok = await updateAlertParams(alert.id, req.session.userId!, validated.params);
    if (!ok) {
      res.status(404).json({ error: "Alert not found" });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to update params" });
  }
});

app.patch("/api/alerts/:id/reset-trigger", requireAuth, async (req, res) => {
  try {
    const ok = await resetTypedTrigger(String(req.params.id), req.session.userId!);
    if (!ok) {
      res.status(404).json({ error: "Alert not found" });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to reset trigger" });
  }
});

app.patch("/api/alerts/:id/reset-breach", requireAuth, async (req, res) => {
  try {
    const { direction } = req.body;
    if (direction !== "above" && direction !== "below") {
      res.status(400).json({ error: "direction must be 'above' or 'below'" });
      return;
    }
    const ok = await resetBreach(String(req.params.id), req.session.userId!, direction);
    if (!ok) {
      res.status(404).json({ error: "Alert not found" });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to reset breach" });
  }
});

// ── Price routes (protected) ────────────────────────────────────────────

app.get("/api/prices", requireAuth, async (req, res) => {
  try {
    const raw = req.query.symbols;
    if (typeof raw !== "string" || !raw.trim()) {
      res.status(400).json({ error: "symbols query param required (comma-separated)" });
      return;
    }
    const symbols = raw.split(",").map(s => s.trim().toUpperCase()).filter(Boolean);
    if (symbols.length === 0) {
      res.json({});
      return;
    }
    const results = await fetchPrices(symbols);
    const map: Record<string, { price: number; name: string }> = {};
    for (const r of results) {
      map[r.symbol] = { price: r.price, name: r.name };
    }
    res.json(map);
  } catch (err) {
    console.error("GET /api/prices error:", (err as Error).message);
    res.status(500).json({ error: "Failed to fetch prices" });
  }
});

app.get("/api/price/:symbol", requireAuth, async (req, res) => {
  try {
    const symbol = String(req.params.symbol);
    const result = await fetchSinglePrice(symbol);
    if (!result) {
      res.status(404).json({ error: `Symbol "${symbol}" not found` });
      return;
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch price" });
  }
});

// ── Cron endpoint (called by GitHub Actions every 5 min) ─────────────────
app.get("/api/cron", async (req, res) => {
  const secret = req.headers["x-cron-secret"];
  const storedSecret = process.env.CRON_SECRET?.trim();
  if (!storedSecret || secret !== storedSecret) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  try {
    if (!await isMarketOpen()) {
      console.log("[cron] Market closed — skipping price check.");
      res.json({ ok: true, timestamp: new Date().toISOString(), skipped: true, reason: "market_closed" });
      return;
    }
    const result = await checkPrices();
    res.json({ ok: true, timestamp: new Date().toISOString(), ...result });
  } catch (err) {
    console.error("Cron check failed:", (err as Error).message);
    res.status(500).json({ error: "Price check failed" });
  }
});

export default app;

// Only start the HTTP server when run directly (local dev: npm run web)
if (process.argv[1]?.includes("server")) {
  app.listen(PORT, () => {
    console.log(`Dashboard running at http://localhost:${PORT}`);
  });
}
