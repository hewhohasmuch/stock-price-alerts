import express from "express";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { listAlerts, addAlert, removeAlert, setAlertEnabled, updateAlertNotes } from "./db.js";
import { fetchSinglePrice, fetchPrices } from "./services/price-fetcher.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = 3000;

app.use(express.json());
app.use(express.static(join(__dirname, "..", "public")));

// List all alerts
app.get("/api/alerts", async (_req, res) => {
  try {
    const alerts = await listAlerts();
    res.json(alerts);
  } catch (err) {
    res.status(500).json({ error: "Failed to list alerts" });
  }
});

// Create a new alert
app.post("/api/alerts", async (req, res) => {
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

// Remove an alert
app.delete("/api/alerts/:id", async (req, res) => {
  try {
    const removed = await removeAlert(req.params.id);
    if (!removed) {
      res.status(404).json({ error: "Alert not found" });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to remove alert" });
  }
});

// Enable an alert
app.patch("/api/alerts/:id/enable", async (req, res) => {
  try {
    const ok = await setAlertEnabled(req.params.id, true);
    if (!ok) {
      res.status(404).json({ error: "Alert not found" });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to enable alert" });
  }
});

// Disable an alert
app.patch("/api/alerts/:id/disable", async (req, res) => {
  try {
    const ok = await setAlertEnabled(req.params.id, false);
    if (!ok) {
      res.status(404).json({ error: "Alert not found" });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to disable alert" });
  }
});

// Update alert notes
app.patch("/api/alerts/:id/notes", async (req, res) => {
  try {
    const { notes } = req.body;
    if (typeof notes !== "string") {
      res.status(400).json({ error: "notes must be a string" });
      return;
    }
    const trimmed = notes.slice(0, 50);
    const ok = await updateAlertNotes(req.params.id, trimmed);
    if (!ok) {
      res.status(404).json({ error: "Alert not found" });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to update notes" });
  }
});

// Fetch live prices for multiple symbols
app.get("/api/prices", async (req, res) => {
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

// Fetch live price for a symbol
app.get("/api/price/:symbol", async (req, res) => {
  try {
    const result = await fetchSinglePrice(req.params.symbol);
    if (!result) {
      res.status(404).json({ error: `Symbol "${req.params.symbol}" not found` });
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
