<#
.SYNOPSIS
    Sets up the stock-price-alerts project on a Windows machine.

.DESCRIPTION
    Clones the stock-price-alerts repository into C:\Projects,
    installs Node.js dependencies, and creates a starter .env file.

.NOTES
    Prerequisites:
      - Git for Windows (https://git-scm.com/download/win)
      - Node.js 18+ (https://nodejs.org)

    Run this script in PowerShell:
      .\setup-windows.ps1
#>

$ErrorActionPreference = "Stop"

$ProjectRoot = "C:\Projects"
$RepoDir     = Join-Path $ProjectRoot "stock-price-alerts"
$RepoUrl     = "https://github.com/hewhohasmuch/stock-price-alerts.git"

# --- Prerequisite checks ------------------------------------------------

function Test-Command($cmd) {
    $null -ne (Get-Command $cmd -ErrorAction SilentlyContinue)
}

Write-Host "`n=== Stock Price Alerts - Windows Setup ===" -ForegroundColor Cyan

if (-not (Test-Command "git")) {
    Write-Host "ERROR: git is not installed or not in PATH." -ForegroundColor Red
    Write-Host "Download Git for Windows: https://git-scm.com/download/win"
    exit 1
}

if (-not (Test-Command "node")) {
    Write-Host "ERROR: node is not installed or not in PATH." -ForegroundColor Red
    Write-Host "Download Node.js: https://nodejs.org"
    exit 1
}

$nodeVersion = (node --version) -replace '^v', ''
$nodeMajor   = [int]($nodeVersion.Split('.')[0])
if ($nodeMajor -lt 18) {
    Write-Host "ERROR: Node.js 18+ is required (found v$nodeVersion)." -ForegroundColor Red
    exit 1
}

Write-Host "  git   : $(git --version)" -ForegroundColor Green
Write-Host "  node  : v$nodeVersion" -ForegroundColor Green
Write-Host "  npm   : $(npm --version)" -ForegroundColor Green

# --- Create project directory -------------------------------------------

if (-not (Test-Path $ProjectRoot)) {
    Write-Host "`nCreating $ProjectRoot ..." -ForegroundColor Yellow
    New-Item -ItemType Directory -Path $ProjectRoot -Force | Out-Null
}

# --- Clone or update repository ----------------------------------------

if (Test-Path (Join-Path $RepoDir ".git")) {
    Write-Host "`nRepository already cloned at $RepoDir" -ForegroundColor Yellow
    Write-Host "Pulling latest changes ..."
    Push-Location $RepoDir
    git pull origin main
    Pop-Location
} else {
    Write-Host "`nCloning repository into $RepoDir ..." -ForegroundColor Yellow
    git clone $RepoUrl $RepoDir
}

# --- Install dependencies ----------------------------------------------

Write-Host "`nInstalling Node.js dependencies ..." -ForegroundColor Yellow
Push-Location $RepoDir
npm install
Pop-Location

# --- Create .env from example if missing --------------------------------

$envFile    = Join-Path $RepoDir ".env"
$envExample = Join-Path $RepoDir ".env.example"

if (-not (Test-Path $envFile)) {
    if (Test-Path $envExample) {
        Copy-Item $envExample $envFile
        Write-Host "`nCreated .env from .env.example — edit it with your credentials." -ForegroundColor Yellow
    } else {
        Write-Host "`nWARNING: .env.example not found. Create a .env file manually." -ForegroundColor Red
    }
} else {
    Write-Host "`n.env already exists — skipping." -ForegroundColor Green
}

# --- Summary ------------------------------------------------------------

Write-Host "`n=== Setup Complete ===" -ForegroundColor Cyan
Write-Host ""
Write-Host "Project location : $RepoDir"
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Yellow
Write-Host "  cd $RepoDir"
Write-Host "  # Edit .env with your SMTP / Twilio credentials"
Write-Host "  npm run cli -- add AAPL --above 200     # add an alert"
Write-Host "  npm run cli -- list                      # list alerts"
Write-Host "  npm run web                              # start web dashboard (port 3000)"
Write-Host "  npm start                                # start price-check scheduler"
Write-Host ""
