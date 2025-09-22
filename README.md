📊 Odds Backend API

A Node.js backend that fetches odds from The Odds API
 and normalizes them into moneyline (H2H), spreads, and totals (Over/Under) markets for multiple sports.

Currently deployed at:
👉 https://odds-backend-oo4k.onrender.com

⚙️ Setup

Clone repo

git clone https://github.com/YOUR_GITHUB/odds-backend.git
cd odds-backend


Install dependencies

npm install


Set up environment variables in .env:

PORT=3000
ODDS_API_KEY=your_odds_api_key_here
ALLOWED_BOOKS=betmgm,caesars,draftkings,fanduel,fanatics,espnbet
CACHE_TTL_SECONDS=30


Start server

npm start

✅ Health Check
GET /health


Response:

{ "ok": true }

🏈 Supported Sports + Markets

NFL: h2h, spreads, totals

MLB: h2h, spreads, totals

NBA: h2h, spreads, totals

NCAAF: h2h, spreads, totals

NCAAB: h2h, spreads, totals

Tennis (ATP): h2h

Soccer (MLS): h2h

📡 Endpoints
🔹 General Format
/api/:sport/:market?compact=true&limit=10&minHold=0.05

🔹 Examples
NFL Moneyline (H2H)
GET /api/nfl/h2h?compact=true&limit=10

NBA Spreads
GET /api/nba/spreads?limit=5

MLB Totals (Over/Under)
GET /api/mlb/totals?compact=true

⚙️ Query Parameters

limit → number of games to return (default = 10)

compact=true → simplified JSON response (smaller & easier for bots)

minHold=0.05 → filter out games with market hold greater than 5%

📦 Example Response (compact=true)
[
  {
    "gameId": "e45f6a|KC Chiefs|BUF Bills",
    "time": "2025-09-20T20:00:00Z",
    "home": "KC Chiefs",
    "away": "BUF Bills",
    "market": "h2h",
    "hold": 0.032,
    "best": {
      "sideA": { "book": "DraftKings", "price": -110 },
      "sideB": { "book": "FanDuel", "price": +105 }
    }
  }
]

🚨 Logging

Every request is logged:

GET /api/nfl/h2h?compact=true


Failures log error messages in server console.

⚠️ Error Handling

Examples:

{ "error": "unsupported", "sport": "rugby", "market": "totals" }

{ "error": "Odds API unavailable. Try again later." }

🔮 Roadmap

 Telegram alerts integration

 Add more sports/leagues (EPL, WTA tennis, etc.)

 Web dashboard for monitoring

 git add .
git commit -m "Trigger redeploy"
git push origin main

## 🔔 Testing Telegram Alerts

You can manually trigger a test message to your Telegram bot without waiting for real odds data.

1. Make sure your Render service is running.
2. Visit this URL in your browser:

https://odds-backend-oo4k.onrender.com/api/test/odds

yaml
Copy code

3. You should immediately see a formatted test alert (Celtics vs Pistons) appear in your `@gosignals_bot` chat.

---

### Notes
- This test endpoint does **not** consume Odds API credits.
- It’s safe to run as often as needed to confirm Telegram connectivity and formatting.
- Once you’re happy with the look, live scans will send the same style of alerts automatically.

📌 Maintainer: You
⚡ Powered by The Odds API + Render
