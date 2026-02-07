# Stock Price Alerts

CLI tool and web dashboard that monitors stock prices and sends email/SMS alerts when prices cross user-defined thresholds.

## Prerequisites

- [Node.js](https://nodejs.org) 18+
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
| `NOTIFY_EMAIL` | Email address to receive alerts |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` | SMTP server settings |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER` | Twilio SMS settings |
| `NOTIFY_SMS` | Phone number to receive SMS alerts |
| `CHECK_INTERVAL_CRON` | Cron expression for check frequency (default: `*/5 * * * *`) |
| `COOLDOWN_MINUTES` | Minutes between repeated notifications (default: `60`) |

Email and SMS are independent — configure either or both.

## Usage

### CLI

```bash
# Add alerts
npm run cli -- add AAPL --above 200
npm run cli -- add TSLA --below 150 --above 300

# List all alerts
npm run cli -- list

# Enable / disable an alert
npm run cli -- enable <id>
npm run cli -- disable <id>

# Remove an alert
npm run cli -- remove <id>
```

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
