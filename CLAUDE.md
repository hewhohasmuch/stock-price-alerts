# CLAUDE.md

## Project Overview

Stock Price Alerts is a Node.js/TypeScript application that monitors stock prices and sends email/SMS notifications when user-defined price thresholds are crossed. It has three entry points: a CLI tool, a web dashboard with REST API, and a background scheduler.

## Tech Stack

- **Runtime**: Node.js with TypeScript 5.7 (ES2022 modules)
- **Web framework**: Express 4.21
- **Database**: lowdb 7 (JSON file at `data/db.json`)
- **Stock prices**: yahoo-finance2
- **Notifications**: Nodemailer (email), Twilio (SMS)
- **Scheduling**: node-cron
- **CLI**: Commander 12
- **TS execution**: tsx (no build step required)

## Project Structure

```
src/
  cli.ts              # CLI entry point (commander-based)
  server.ts           # Express web server entry point (port 3000)
  scheduler.ts        # Background cron scheduler entry point
  config.ts           # Environment variable loading via dotenv
  db.ts               # Database operations (lowdb)
  types.ts            # TypeScript interfaces (StockAlert, Settings, etc.)
  services/
    price-fetcher.ts  # Yahoo Finance API integration
    alert-evaluator.ts # Pure function: evaluates which alerts are triggered
    notifier.ts       # Orchestrates email + SMS delivery
    email-sender.ts   # Nodemailer SMTP integration
    sms-sender.ts     # Twilio SMS integration
public/
  index.html          # Web dashboard (single-file HTML/CSS/JS)
```

## Commands

```bash
npm run start   # Run background scheduler (src/scheduler.ts)
npm run cli     # Run CLI tool (src/cli.ts)
npm run web     # Run web server on port 3000 (src/server.ts)
```

### CLI usage

```bash
npm run cli -- add AAPL --above 200 --below 150
npm run cli -- remove <id>
npm run cli -- list
npm run cli -- enable <id>
npm run cli -- disable <id>
```

## REST API

Base: `http://localhost:3000/api`

| Method | Path | Description |
|--------|------|-------------|
| GET | /alerts | List all alerts |
| POST | /alerts | Create alert (body: `{symbol, abovePrice?, belowPrice?, notes?}`) |
| DELETE | /alerts/:id | Remove alert |
| PATCH | /alerts/:id/enable | Enable alert |
| PATCH | /alerts/:id/disable | Disable alert |
| PATCH | /alerts/:id/notes | Update notes (body: `{notes}`, max 50 chars) |
| GET | /prices?symbols=X,Y | Fetch multiple stock prices |
| GET | /price/:symbol | Fetch single stock price |

## Configuration

Copy `.env.example` to `.env`. Key variables:

- **Email**: `NOTIFY_EMAIL`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`
- **SMS**: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`, `NOTIFY_SMS`
- **Scheduler**: `CHECK_INTERVAL_CRON` (default: `*/5 * * * *`), `COOLDOWN_MINUTES` (default: 60)

Email and SMS are independently optional; the app checks configuration at runtime via `isEmailConfigured()` / `isSmsConfigured()` in `src/config.ts`.

## Architecture Notes

- **No build step**: The project uses `tsx` to run TypeScript directly. There is no compiled `dist/` output.
- **No test suite**: No testing framework or test files exist yet.
- **No linter/formatter**: No ESLint or Prettier configuration.
- **No CI/CD**: No GitHub Actions or other pipeline configuration.
- **Database**: lowdb writes the entire JSON file on each mutation. The `data/` directory is gitignored.
- **Module system**: ESM (`"type": "module"` in package.json, `"module": "ES2022"` in tsconfig).
- **Strict mode**: TypeScript strict mode is enabled.
- **Alert IDs**: 8-character random hex strings generated via `crypto.randomUUID()`.
- **Cooldown**: After an alert fires, it won't re-fire for `COOLDOWN_MINUTES` (tracked via `lastNotifiedAt` on each alert).

## Key Conventions

- All source files are in `src/` with flat structure except `src/services/` for external integrations.
- Interfaces and types live in `src/types.ts`.
- Configuration is centralized in `src/config.ts` (reads from `process.env`).
- Database access is through `src/db.ts` helper functions (not direct lowdb usage elsewhere).
- The web dashboard is a single self-contained HTML file in `public/index.html`.
