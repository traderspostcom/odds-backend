📊 GoSignals Backend

Backend service for scanning betting markets, detecting sharp action, and sending Telegram alerts. Deployed on Render.

🚀 Features

Sports Supported

MLB: Full game + First 5 (H2H, Totals, Spreads, Team Totals)

NFL, NBA, NCAAF, NCAAB: H2H, Totals, Spreads

Tennis & Soccer: H2H only

Sharp Detection

Alerts only when tickets% ≤ 40% and handle% ≥ tickets% + 10% (configurable via .env)

Toggle sharp-only mode via SHARPS_ONLY=true/false

Telegram Alerts

Bot: @gosignals_bot

Batched alerts (1 Telegram message per scan)

Header shows mode (ALL/SHARPS_ONLY), ET timestamp, and total count

Automation

Cron auto-scans every 30s (during configured hours)

Directly calls fetchers (faster + saves API credits)

Credits Management

Track monthly API credits used vs. CREDITS_MONTHLY_LIMIT

🚨 Telegram + console warning at 97% usage

📅 Daily usage summary at midnight ET

🔄 Automatic monthly reset at midnight ET on the 1st

⚙️ Setup
1. Environment Variables (.env)
# Telegram
TELEGRAM_BOT_TOKEN=your-bot-token
TELEGRAM_CHAT_ID=your-chat-id

# Sports to scan (comma separated)
SCAN_SPORTS=mlb,nfl,nba,ncaaf,ncaab

# Sharp settings
SHARPS_ONLY=true       # true = only sharp alerts, false = all alerts

# Scan window (24h format, Eastern Time)
SCAN_START_HOUR=0      # midnight ET
SCAN_STOP_HOUR=24      # 11:59 PM ET

# Credits
CREDITS_MONTHLY_LIMIT=19000
CREDITS_ALERT_THRESHOLD=97   # percent

2. Endpoints

Health check
GET /health

MLB First 5 scan
GET /api/mlb/f5_scan?telegram=true

MLB full game scan
GET /api/mlb/game_scan?telegram=true

Generic odds fetcher
GET /api/:sport/:market

Supports query params:

limit=10

telegram=true

compact=true

raw=true

3. Automation

Runs every 30s (cron.schedule("*/30 * * * * *"))

Scans all sports in SCAN_SPORTS

Sends batched Telegram alerts if sharp action is detected

4. Credit Tracking

Every fetch increments credit usage (trackCredits())

Daily midnight ET → sends usage summary

1st of month midnight ET → resets credits and sends reset confirmation

Alert when usage ≥ threshold (CREDITS_ALERT_THRESHOLD, default 97%)

📲 Telegram Alerts
Batch Alert Example
🔔 GoSignals Batch Alert
Mode: SHARPS_ONLY
⏰ Sep 23, 7:05:30 PM ET
Total: 3

────────────

📊 GoSignals Sharp Alert!

📅 7:05 PM ET
⚔️ Yankees @ Red Sox

🎯 Market: ML

🏠 Red Sox: DraftKings (-120)
🛫 Yankees: FanDuel (+110)

📈 Tickets: 28% | Handle: 52%
⚡ Gap: +24%

Daily Summary Example
📅 Daily Usage Summary

Date: Sep 25, 12:00 AM ET

📊 Today: 645 credits
📊 Month: 14,955/19,000 (78.7%)

Monthly Reset Example
📅 Daily Usage Summary

Date: Oct 1, 12:00 AM ET

📊 Today: 480 credits
📊 Month: 18,530/19,000 (97.5%)

🔄 Monthly Reset Performed
Credits counter reset to 0/19000

🛠️ Developer Notes

Batch alert formatting: telegram.js → formatSharpBatch()

Credit tracking: src/index.js → trackCredits()

Alerts are only sent if:

?telegram=true query param is present, OR

Called via cron auto-scan

✅ With this setup, you’ll never lose track of sharp signals or API usage again.
