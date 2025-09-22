# 📊 GoSignals Backend

Backend service for scanning betting markets, detecting sharp action, and sending Telegram alerts. Deployed on Render.

---

## 🚀 Features

### Sports Supported
- **MLB**: Full game + First 5 (H2H, Totals, Spreads, Team Totals)
- **NFL, NBA, NCAAF, NCAAB**: H2H, Totals, Spreads (plus 1H if enabled)
- **Tennis & Soccer**: H2H only

### Sharp Detection
- Configurable profiles (`sharpest`, `pro`, `balanced`) via `.env`
- Default: `SHARP_PROFILE=sharpest`
- Alerts trigger on handle/ticket imbalance + sharp signals
- State persisted → re-alerts when numbers come back or improve

### Telegram Alerts
- Batched alerts → 1 Telegram message per scan
- Clean formatting, ET timestamps, sharps-only mode supported
- Supports 🟢 RE-ALERT and 🟢 RE-ALERT+ if sharp numbers return/improve

### Automation
- Cron scans every `SCAN_INTERVAL` minutes (configurable)
- Auto-respects `SCAN_START_HOUR` and `SCAN_STOP_HOUR` (Eastern Time)

### Credits Management
- Tracks credits used vs. `CREDITS_MONTHLY_LIMIT`
- Sends Telegram + console warning when threshold (`CREDITS_ALERT_THRESHOLD`) reached
- Resets automatically on 1st of each month

---

## ⚙️ Setup

### Environment Variables (.env)

```env
# Telegram
TELEGRAM_BOT_TOKEN=xxx
TELEGRAM_CHAT_ID=xxx

# Sports to scan (comma separated)
SCAN_SPORTS=mlb,nfl,ncaaf

# Market toggles
SCAN_MLB_F5=true
SCAN_MLB_FULL=true
SCAN_NFL_H1=true
SCAN_NFL_FULL=true
SCAN_NCAAF_H1=true
SCAN_NCAAF_FULL=true
SCAN_NBA_H1=false
SCAN_NBA_FULL=false
SCAN_NCAAB_H1=false
SCAN_NCAAB_FULL=false

# Sharp profile (choose: sharpest, pro, balanced)
SHARP_PROFILE=sharpest
🔧 Controlling Sharp Profiles

The system supports three profiles for different levels of signal strictness:

sharpest 🟢 → Tightest filters (tickets ≤ 40%, handle gap ≥ 15, hold ≤ 2.5%).

pro 🟡 → Medium filters (tickets ≤ 45%, handle gap ≥ 10, hold ≤ 3.5%).

balanced 🟠 → Looser filters (tickets ≤ 50%, handle gap ≥ 8, hold ≤ 5%).

How It Works

In config.js you’ll see:

activeProfile: process.env.SHARP_PROFILE || "sharpest"


This means:

The system will read the SHARP_PROFILE variable from your environment.

If you don’t set anything, it defaults to "sharpest".

Setting the Profile

You control the profile in your .env file (project root, same place as package.json).
Add one of these lines:

SHARP_PROFILE=sharpest

SHARP_PROFILE=pro

SHARP_PROFILE=balanced


After updating .env:

Locally → restart your server (npm start).

On Render → add/update the Environment Variable in the Render dashboard and redeploy.

The backend will then apply the thresholds and re-alert rules defined in that profile.
