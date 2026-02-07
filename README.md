# Stock Price Alerts

A stock price monitoring tool that sends email and SMS notifications when prices cross user-defined thresholds. Includes a CLI, web dashboard, and background scheduler.

## Prerequisites

- [Node.js](https://nodejs.org/) v18 or later (download the Windows installer from nodejs.org)
- npm (included with Node.js)

## Setup

1. Open **PowerShell** or **Command Prompt** and clone the repository:

```powershell
git clone https://github.com/hewhohasmuch/stock-price-alerts.git
cd stock-price-alerts
```

2. Install dependencies:

```powershell
npm install
```

3. Copy the example environment file and edit it with your credentials:

```powershell
copy .env.example .env
notepad .env
```

## Running

### Web Dashboard

```powershell
npm run web
```

Then open `http://localhost:3000` in your browser.

### Background Scheduler

Monitors prices on a cron schedule and sends alerts:

```powershell
npm run start
```

### CLI

```powershell
npm run cli -- add AAPL --above 200 --below 150
npm run cli -- list
npm run cli -- remove <id>
npm run cli -- enable <id>
npm run cli -- disable <id>
```

## Running as a Background Service (Windows)

To keep the scheduler running in the background, you can use **Task Scheduler**:

1. Open **Task Scheduler** (`taskschd.msc`)
2. Click **Create Basic Task**
3. Set the trigger to **When the computer starts**
4. Set the action to **Start a program**:
   - Program: `node`
   - Arguments: `node_modules\.bin\tsx src\scheduler.ts`
   - Start in: `C:\path\to\stock-price-alerts`
5. Check **Open the Properties dialog** and enable **Run whether user is logged on or not**

Alternatively, use [pm2](https://pm2.keymetrics.io/) for process management:

```powershell
npm install -g pm2
pm2 start "npx tsx src/scheduler.ts" --name stock-alerts
pm2 save
```

## Configuration

Edit the `.env` file to configure notifications and scheduling. See `.env.example` for all available options.

| Variable | Description | Default |
|----------|-------------|---------|
| `NOTIFY_EMAIL` | Email address for alerts | — |
| `SMTP_HOST` | SMTP server hostname | — |
| `SMTP_PORT` | SMTP server port | `587` |
| `SMTP_USER` | SMTP username | — |
| `SMTP_PASS` | SMTP password or app password | — |
| `TWILIO_ACCOUNT_SID` | Twilio account SID | — |
| `TWILIO_AUTH_TOKEN` | Twilio auth token | — |
| `TWILIO_FROM_NUMBER` | Twilio sender phone number | — |
| `NOTIFY_SMS` | SMS recipient phone number | — |
| `CHECK_INTERVAL_CRON` | Cron schedule for price checks | `*/5 * * * *` |
| `COOLDOWN_MINUTES` | Minutes between repeated alerts | `60` |

Email and SMS are independently optional. The app works with either, both, or neither configured.
