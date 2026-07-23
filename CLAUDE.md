# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run build      # tsc --noEmit — type-check src/ and api/, no output
npm test           # vitest run tests/alert-evaluator.test.ts (the only suite run in CI/pre-commit)
npm run test:all   # vitest run — all test files, see caveat below
npm run cli -- <cmd>   # run the CLI (tsx src/cli.ts)
npm run web         # run the Express dashboard locally (tsx src/server.ts), http://localhost:3000
npm start           # run the standalone scheduler loop (tsx src/scheduler.ts) — local/dev only, not used in production
```

To run a single test file directly: `npx vitest run tests/<file>.test.ts`. To run one test by name: `npx vitest run tests/<file>.test.ts -t "<test name>"`.

**Test caveat:** `tests/db.test.ts` and `tests/server.test.ts` are not part of the default `npm test` run and are not reliable:
- `db.test.ts`'s comments describe a file-based `DATA_DIR` JSON store that no longer exists — `src/db.ts` is Postgres-backed. The tests do run against whatever `DATABASE_URL` resolves to (real Postgres, no isolation/mocking, no rollback), so `npm run test:all` will write real rows to your local `.env`-configured database.
- `server.test.ts` assumes an already-running server on `localhost:3000` rather than booting one itself.

## Architecture

This is a single Node/TypeScript backend with three entry points sharing one service/data layer:

- **`src/cli.ts`** — Commander-based CLI (`npm run cli`). Operates per-user via `-u <username>`.
- **`src/server.ts`** — Express app: session-authenticated REST API + static dashboard (`public/`) + `GET /api/cron`. This is the module deployed to Vercel (via `api/index.ts`, which just re-exports the Express `app`; `vercel.json` rewrites all requests to it). It only calls `app.listen()` when run directly (`npm run web`), not when imported serverlessly.
- **`src/scheduler.ts`** — exports `checkPrices()` (one price-check pass) and `startScheduler()` (in-process `node-cron` loop for local dev via `npm start`). **In production, there is no long-running scheduler process** — Vercel functions are ephemeral, so a GitHub Actions workflow (`.github/workflows/keep-alive.yml`, despite the filename it's the "Price Check" cron) hits `GET /api/cron` every 5 minutes with header `x-cron-secret: $CRON_SECRET`, which calls the same `checkPrices()`.

### Data flow of a price check (`checkPrices()` in `src/scheduler.ts`)

1. `isMarketOpen()` (`src/utils/market-hours.ts`) gates the whole check — queries the Alpaca clock API if `ALPACA_API_KEY`/`ALPACA_SECRET_KEY` are set, otherwise falls back to a hardcoded NYSE-hours calculation. If Alpaca isn't configured, market is assumed **closed** (fails safe, not open).
2. `getEnabledAlerts()` (`src/db.ts`) loads all enabled alerts across all users, joined with each user's notification email.
3. `fetchPrices()` (`src/services/price-fetcher.ts`) pulls quotes from Yahoo Finance's undocumented chart API, sequentially per symbol (avoids rate limiting), with a 30s in-memory cache keyed by the sorted symbol set.
4. `evaluateAlerts()` (`src/services/alert-evaluator.ts`) dispatches each alert to a per-`alertType` evaluator (strategy pattern — see below) and returns both triggered alerts and any evaluator-mutated `state` that needs persisting (e.g. a ratcheted trailing high).
5. `notify()` (`src/services/notifier.ts`) sends email (`nodemailer`) and/or SMS (`twilio`) for each triggered alert, independently — one channel failing doesn't block the other — and records `lastNotifiedAt`/`lastTriggeredAt` only for channels that actually succeeded.

### Alert types (strategy pattern, `src/services/alert-evaluator.ts`)

`StockAlert.alertType` selects the evaluator; `undefined`/`null` means the legacy type:

- **`absolute-threshold`** (legacy, no `alertType` set) — uses the `abovePrice`/`belowPrice` columns directly. Cooldown is "once per calendar day" per direction (`lastNotifiedAboveAt`/`lastNotifiedBelowAt`), not the `COOLDOWN_MINUTES` config value (that setting is currently unused by evaluation logic).
- **`percent-change`** — fires once per day when the price moves ≥N% from the previous close, in an up/down/either direction (`params: PercentChangeParams`).
- **`trailing-high`** — stateful drawdown alert (`params: TrailingHighParams`, `state: TrailingHighState`). Tracks a high-water mark that ratchets up every check; fires once when price drops N% below it, and re-arms only once a new high is set. The high-water mark is sampled at scheduler-interval granularity, not the true intraday high.

Adding a new alert type means: extend `AlertType`/`AlertParams` in `src/types.ts`, add an `AlertEvaluator` to the `evaluators` map, and add validation in `validateAlertParams()` in `src/server.ts`.

### Database (`src/db.ts`)

Single Postgres pool (`pg`), schema created/migrated idempotently on startup via `initDb()` (`CREATE TABLE IF NOT EXISTS` + `ALTER TABLE ADD COLUMN IF NOT EXISTS` — there is no separate migrations directory/tool). `src/server.ts` calls `initDb()` lazily on first request (serverless-safe) rather than at module load. Typed-alert params/state are stored as `JSONB` columns (`params_json`, `state_json`); legacy alerts use dedicated `above_price`/`below_price` columns. Prefers `DATABASE_URL_UNPOOLED` over `DATABASE_URL` (Neon's pooled connection blocks startup params).

The alerts table also carries the Shortlist bookkeeping as dedicated scalar columns (`shortlisted BOOLEAN`, `shares DOUBLE PRECISION DEFAULT 1`, `staged BOOLEAN`) — not JSONB, since they're fixed-shape scalars like `enabled`. These are pure user-planning flags with **no connection to alert-trigger logic** (`getEnabledAlerts()`/the scheduler ignore them). `setAlertShortlisted(id, userId, false)` also resets `shares`→1 and `staged`→false, so re-shortlisting a ticker starts fresh. Any new column must be added in three places: the `initDb()` migration, `rowToAlert()`, and `ALERT_COLUMNS`. Single-field mutations follow the `setAlertEnabled`/`updateAlertNotes` template (`UPDATE … WHERE id = $ AND user_id = $`), exposed as `PATCH /api/alerts/:id/{shortlist,unshortlist,shares,stage}`.

### Auth & sessions

`express-session` backed by Postgres (`connect-pg-simple`, same pool). `SESSION_SECRET` is required in production (throws at startup if missing) and falls back to a random per-process UUID otherwise. Simple username/password auth (`bcryptjs`), no external auth provider. IP-based rate limiting for `/api/auth/*` (10 attempts / 15 min) is implemented in Postgres (`login_attempts` table), not in-memory — works correctly across serverless invocations.

### Frontend

`public/` is a static, framework-free HTML/JS/CSS dashboard served directly by Express — no build step, no bundler. It's a single file (`public/index.html`) with inline `<style>`/`<script>`; alerts render as `<table>` rows that CSS-reflow into cards under `@media (max-width: 640px)`.

The dashboard has two tabs (`showWatchlistTab()`/`showShortlistTab()`):
- **Watchlist** — the "Add Alert" form + the alerts table (the original view).
- **Shortlist** — a table (Ticker/Price/Shares/Total/Stage) of alerts the user has starred via the bookmark toggle on each Watchlist row. It's a **derived client-side view**: `renderShortlistTable()` filters the same `allAlerts` array loaded by `loadAlerts()` for `shortlisted === true` (sorted by symbol) — no separate fetch. Price reuses the existing `.price-cell`/`loadPrices()` mechanism; Total (`Price × Shares`) and the staged-only subtotal (`recomputeShortlistTotals()`) are computed client-side and never persisted. Mutations follow the app's fire-`PATCH`-then-`loadAlerts()` convention, which re-renders both tabs and keeps them in sync.

## Configuration

Env vars are read once into `src/config.ts` (loaded via `dotenv/config`). Notification channels are independently optional — checked via `isEmailConfigured()`/`isSmsConfigured()`; a missing channel is skipped, not an error. See `.env.example` for the full list. Notable ones not obvious from naming:
- `CRON_SECRET` — shared secret the GitHub Actions workflow sends to authenticate `GET /api/cron`; not in `.env.example`, must be set in both Vercel env vars and the GitHub Actions secret.
- `ALPACA_API_KEY`/`ALPACA_SECRET_KEY` — only used for the market-open check, not price data (Yahoo Finance is unauthenticated and used for all actual quotes).
