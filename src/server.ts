import express from "express";
import session from "express-session";
import { randomUUID } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  listAlerts, addAlert, removeAlert, setAlertEnabled, updateAlertNotes,
  updateAlertThresholds, createUser, verifyUser,
} from "./db.js";
import { fetchSinglePrice, fetchPrices } from "./services/price-fetcher.js";
import { startScheduler } from "./scheduler.js";

declare module "express-session" {
  interface SessionData {
    userId: string;
    username: string;
  }
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = 3000;
const isProduction = process.env.NODE_ENV === "production";

// ── Session secret validation ────────────────────────────────────────────
const sessionSecret = process.env.SESSION_SECRET;
if (isProduction && !sessionSecret) {
  console.error("FATAL: SESSION_SECRET environment variable is required in production.");
  console.error("Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"");
  process.exit(1);
}
if (!sessionSecret) {
  console.warn("WARNING: SESSION_SECRET is not set. Using a random secret — sessions will not survive restarts.");
}
const resolvedSecret = sessionSecret || randomUUID();

// ── In-memory session store warning ──────────────────────────────────────
if (isProduction) {
  console.warn("WARNING: Using default in-memory session store. Sessions will be lost on restart and memory may leak under load.");
  console.warn("Consider using a persistent session store (e.g. connect-pg-simple, connect-redis) in production.");
}

app.use(express.json());

app.use(
  session({
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

if (isProduction) {
  app.set("trust proxy", 1);
}

app.use(express.static(join(__dirname, "..", "public")));

// ── Rate limiting for auth endpoints ─────────────────────────────────────
const loginAttempts = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const RATE_LIMIT_MAX = 10; // max attempts per window

function rateLimitAuth(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
) {
  const key = req.ip || "unknown";
  const now = Date.now();
  const entry = loginAttempts.get(key);

  if (entry && now < entry.resetAt) {
    if (entry.count >= RATE_LIMIT_MAX) {
      const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
      res.status(429).json({
        error: "Too many attempts. Please try again later.",
        retryAfterSeconds: retryAfter,
      });
      return;
    }
    entry.count++;
  } else {
    loginAttempts.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
  }

  // Periodically clean up expired entries to prevent memory buildup
  if (loginAttempts.size > 10000) {
    for (const [k, v] of loginAttempts) {
      if (now >= v.resetAt) loginAttempts.delete(k);
    }
  }

  next();
}

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

app.get("/api/auth/me", (req, res) => {
  if (!req.session.userId) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  res.json({ id: req.session.userId, username: req.session.username });
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
    const { symbol, abovePrice, belowPrice, notes } = req.body;
    if (!symbol || (abovePrice == null && belowPrice == null)) {
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

    const alert = await addAlert(
      req.session.userId!,
      resolvedSymbol,
      resolvedName,
      abovePrice != null ? Number(abovePrice) : undefined,
      belowPrice != null ? Number(belowPrice) : undefined,
      notes ? String(notes).slice(0, 50) : undefined
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

app.listen(PORT, () => {
  console.log(`Dashboard running at http://localhost:${PORT}`);
  startScheduler();
});
