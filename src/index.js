// src/index.js
import "dotenv/config";
import express from "express";
import cors from "cors";
import cron from "node-cron";

import {
  // NFL
  getNFLH2HNormalized, getNFLSpreadsNormalized, getNFLTotalsNormalized,
  getNFLF5H2HNormalized, getNFLF5TotalsNormalized,

  // MLB
  getMLBH2HNormalized, getMLBSpreadsNormalized, getMLBTotalsNormalized,
  getMLBF5H2HNormalized, getMLBF5TotalsNormalized,
  getMLBTeamTotalsNormalized, getMLBAltLinesNormalized,

  // NBA
  getNBAH2HNormalized, getNBASpreadsNormalized, getNBATotalsNormalized,
  getNBAF5H2HNormalized, getNBAF5TotalsNormalized,

  // NCAAF
  getNCAAFH2HNormalized, getNCAAFSpreadsNormalized, getNCAAFTotalsNormalized,
  getNCAAFF5H2HNormalized, getNCAAFF5TotalsNormalized,

  // NCAAB
  getNCAABH2HNormalized, getNCAABSpreadsNormalized, getNCAABTotalsNormalized,

  // Tennis + Soccer
  getTennisH2HNormalized, getSoccerH2HNormalized,

  // Generic props
  getPropsNormalized
} from "../odds_service.js";

import { sendTelegramMessage, formatSharpBatch } from "../telegram.js";

const app = express();
app.use(cors());

/* -------------------- Health -------------------- */
app.get("/health", (_req, res) => res.json({ ok: true }));

/* -------------------- Multi-Sport Router -------------------- */
const FETCHERS = {
  nfl: {
    h2h: getNFLH2HNormalized, spreads: getNFLSpreadsNormalized, totals: getNFLTotalsNormalized,
    f5_h2h: getNFLF5H2HNormalized, f5_totals: getNFLF5TotalsNormalized
  },
  mlb: {
    h2h: getMLBH2HNormalized, spreads: getMLBSpreadsNormalized, totals: getMLBTotalsNormalized,
    f5_h2h: getMLBF5H2HNormalized, f5_totals: getMLBF5TotalsNormalized,
    team_totals: getMLBTeamTotalsNormalized, alt: getMLBAltLinesNormalized
  },
  nba: {
    h2h: getNBAH2HNormalized, spreads: getNBASpreadsNormalized, totals: getNBATotalsNormalized,
    f5_h2h: getNBAF5H2HNormalized, f5_totals: getNBAF5TotalsNormalized
  },
  ncaaf: {
    h2h: getNCAAFH2HNormalized, spreads: getNCAAFSpreadsNormalized, totals: getNCAAFTotalsNormalized,
    f5_h2h: getNCAAFF5H2HNormalized, f5_totals: getNCAAFF5TotalsNormalized
  },
  ncaab: { h2h: getNCAABH2HNormalized, spreads: getNCAABSpreadsNormalized, totals: getNCAABTotalsNormalized },
  tennis: { h2h: getTennisH2HNormalized },
  soccer: { h2h: getSoccerH2HNormalized }
};

/* -------------------- Credit Tracker -------------------- */
let creditsUsed = 0;
const CREDITS_LIMIT = Number(process.env.CREDITS_MONTHLY_LIMIT || 19000);
const CREDIT_ALERT_THRESHOLD = CREDITS_LIMIT * 0.95; // 95%

function addCredits(count) {
  creditsUsed += count;
  if (creditsUsed >= CREDIT_ALERT_THRESHOLD) {
    sendTelegramMessage(`⚠️ Credits used: ${creditsUsed}/${CREDITS_LIMIT} (95% reached)`);
  }
}

/* -------------------- Sharp Bet Counter -------------------- */
let sharpBetsToday = 0;

/* -------------------- Scanning Function -------------------- */
async function runScans() {
  const now = new Date();
  const startHour = Number(process.env.SCAN_START_HOUR || 7);
  const stopHour = Number(process.env.SCAN_STOP_HOUR || 23);

  const estHour = now.getUTCHours() - 5; // convert UTC → ET
  if (estHour < startHour || estHour >= stopHour) {
    return; // outside scan window
  }

  try {
    // Example: MLB First 5 + Full Game
    const f5_h2h = await FETCHERS.mlb.f5_h2h({ minHold: null });
    const f5_totals = await FETCHERS.mlb.f5_totals({ minHold: null });
    const combined = [...(f5_h2h || []), ...(f5_totals || [])];

    if (combined.length > 0) {
      const message = formatSharpBatch(combined);
      await sendTelegramMessage(message);
      sharpBetsToday += combined.length;
    }

    addCredits(2); // count 2 calls for MLB F5
  } catch (err) {
    console.error("Scan error:", err);
  }
}

/* -------------------- Scheduler -------------------- */
cron.schedule("*/30 * * * * *", runScans); // every 30s

// End-of-day summary (11:01pm ET)
cron.schedule("1 23 * * *", async () => {
  await sendTelegramMessage(`📊 Daily Summary: ${sharpBetsToday} sharp bets alerted today.`);
  sharpBetsToday = 0; // reset for next day
});

/* -------------------- Odds Handler -------------------- */
async function oddsHandler(req, res) {
  try {
    const sport = String(req.params.sport || "").toLowerCase();
    const market = String(req.params.market || "").toLowerCase();

    if (!FETCHERS[sport] || !FETCHERS[sport][market]) {
      return res.status(400).json({ error: "unsupported", sport, market });
    }

    const data = await FETCHERS[sport][market]({ minHold: null });
    addCredits(1);

    res.json(Array.isArray(data) ? data.slice(0, 10) : []);
  } catch (err) {
    console.error("oddsHandler error:", err);
    res.status(500).json({ error: String(err) });
  }
}

app.get("/api/:sport/:market", oddsHandler);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
