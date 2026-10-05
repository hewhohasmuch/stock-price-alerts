# Stock Price Alerts

CLI tool and web dashboard that monitors stock prices and sends email/SMS alerts when prices cross user-defined thresholds.

The web dashboard (live at https://wekintech.com) also has:
- **Market direction arrows** for the S&P 500, Dow, Nasdaq and Russell 2000, based on the last ~90 minutes of trading. Tap a card for details.
- **Accounts with recovery**: sign-up with email confirmation, "Forgot password?" via an emailed one-time link, and password/email changes in Settings.

## Prerequisites

- [Node.js](https://nodejs.org) 20+
- [Git](https://git-scm.com)

## Setup

### Windows

A PowerShell setup script is included that clones the project into `C:\Projects\stock-price-alerts` and installs dependencies:

```powershell
# One-time setup — run from any PowerShell window:
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned   # allow local scripts (once)
.\setup-windows.ps1
```

Or clone manually:

```powershell
mkdir C:\Projects
cd C:\Projects
git clone https://github.com/hewhohasmuch/stock-price-alerts.git
cd stock-price-alerts
npm install
copy .env.example .env   # then edit .env with your credentials
```

### Linux / macOS / ChromeOS

```bash
git clone https://github.com/hewhohasmuch/stock-price-alerts.git
cd stock-price-alerts
npm install
cp .env.example .env     # then edit .env with your credentials
```

## Configuration

Copy `.env.example` to `.env` and fill in your credentials:

| Variable | Description |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `SESSION_SECRET` | Secret for signing login sessions (required in production) |
| `APP_URL` | Public base URL used in password-reset and email-confirmation links, e.g. `https://wekintech.com`. Without it those emails aren't sent |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` | SMTP server settings (alert emails and account emails) |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER` | Twilio SMS settings |
| `NOTIFY_SMS` | Phone number to receive SMS alerts |
| `ALPACA_API_KEY`, `ALPACA_SECRET_KEY` | Used only to check whether the market is open (without them it's treated as closed) |
| `CHECK_INTERVAL_CRON` | Cron expression for the local scheduler (default: `*/5 * * * *`) |
| `DEV_LOG_EMAIL_LINKS` | Local development only: set to `1` to print account emails to the console instead of sending them |

Alert emails go to each user's own confirmed email address (set at sign-up or in Settings), not to a fixed address. Email and SMS are independent — configure either or both.

## Usage

### CLI

Every command acts as a user, given with `-u <username>`:

```bash
# Add alerts
npm run cli -- -u alice add AAPL --above 200
npm run cli -- -u alice add TSLA --below 150 --above 300

# List all alerts
npm run cli -- -u alice list

# Enable / disable an alert
npm run cli -- -u alice enable <id>
npm run cli -- -u alice disable <id>

# Remove an alert
npm run cli -- -u alice remove <id>
```

Create accounts through the web dashboard. It enforces the email and password rules; the CLI's `register` command doesn't yet.

### Web Dashboard

```bash
npm run web
# Open http://localhost:3000
```

### Scheduler (background monitoring)

```bash
npm start
```

Runs price checks on the configured cron schedule and sends notifications when thresholds are crossed.
