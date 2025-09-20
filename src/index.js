import express from "express";
import { google } from "googleapis";
import { fetchOddsAndNormalize } from "../odds_service.js";  // ✅ root file
import { ipFromAmerican, evAmerican } from "../odds_math.js"; // ✅ root file

const app = express();
app.use(express.json({ limit: "5mb" }));

const PORT = process.env.PORT || 3000;
const SHARED_TOKEN = process.env.SHARED_TOKEN;
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const GOOGLE_CLIENT_EMAIL = process.env.GOOGLE_CLIENT_EMAIL;
const GOOGLE_PRIVATE_KEY = (process.env.GOOGLE_PRIVATE_KEY || "").replace(/\\n/g, "\n");

if (!SHARED_TOKEN || !SPREADSHEET_ID || !GOOGLE_CLIENT_EMAIL || !GOOGLE_PRIVATE_KEY) {
  console.error("Missing env vars.");
  process.exit(1);
}

// Google Sheets auth
const auth = new google.auth.JWT(
  GOOGLE_CLIENT_EMAIL,
  null,
  GOOGLE_PRIVATE_KEY,
  ["https://www.googleapis.com/auth/spreadsheets"]
);
const sheets = google.sheets({ version: "v4", auth });

/** Root check */
app.get("/", (req, res) => res.json({ ok: true, service: "bets-to-sheets" }));

/** ✅ Odds lookup route */
app.get("/odds", async (req, res) => {
  try {
    const { sportKey, market, team, side, spreadPoint, totalPoint, books, line } = req.query;

    if (!sportKey) {
      return res.status(400).json({ ok: false, error: "sportKey is required" });
    }

    const oddsInfo = await fetchOddsAndNormalize({
      sportKey,
      market,
      team,
      side,
      spreadPoint: spreadPoint ? Number(spreadPoint) : null,
      totalPoint: totalPoint ? Number(totalPoint) : null,
      books: books ? books.split(",").map(s => s.trim()) : [],
      line
    });

    return res.json({ ok: true, result: oddsInfo });
  } catch (err) {
    console.error("Odds endpoint failed:", err);
    return res.status(500).json({ ok: false, error: err.message || String(err) });
  }
});

/** Placeholder ingest route */
app.post("/ingest", async (req, res) => {
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
