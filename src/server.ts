import express from "express";
import session from "express-session";
import { randomUUID } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  listAlerts, addAlert, removeAlert, setAlertEnabled, updateAlertNotes,
  createUser, verifyUser,
} from "./db.js";
import { fetchSinglePrice, fetchPrices } from "./services/price-fetcher.js";

declare module "express-session" {
  interface SessionData {
    userId: string;
    username: string;
  }
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = 3000;

app.use(express.json());

app.use(
  session({
    secret: process.env.SESSION_SECRET || randomUUID(),
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    },
  })
);

app.use(express.static(join(__dirname, "..", "public")));

// ── Auth routes ─────────────────────────────────────────────────────────

app.post("/api/auth/register", async (req, res) => {
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

app.post("/api/auth/login", async (req, res) => {
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
    } catch {
      // Yahoo Finance may be rate-limited; proceed with symbol as name
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
    const map: Record<string, number> = {};
    for (const r of results) {
      map[r.symbol] = r.price;
    }
    res.json(map);
  } catch (err) {
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
});
