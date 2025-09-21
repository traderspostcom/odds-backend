// src/index.js
import "dotenv/config";
import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import {
  // NFL
  getNFLH2HNormalized, getNFLTotalsNormalized,
  getNFLF5H2HNormalized, getNFLF5TotalsNormalized,

  // MLB
  getMLBH2HNormalized, getMLBTotalsNormalized,
  getMLBF5H2HNormalized, getMLBF5TotalsNormalized,

  // NBA
  getNBAH2HNormalized, getNBATotalsNormalized,
  getNBAF5H2HNormalized, getNBAF5TotalsNormalized,

  // NCAAF
  getNCAAFH2HNormalized, getNCAAFTotalsNormalized,
  getNCAAFF5H2HNormalized, getNCAAFF5TotalsNormalized,

  // NCAAB
  getNCAABH2HNormalized, getNCAABTotalsNormalized,

  // Tennis + Soccer
  getTennisH2HNormalized, getSoccerH2HNormalized,

  // Generic props
  getPropsNormalized
} from "../odds_service.js";

import { sendTelegramMessage } from "../telegram.js";

// -------------------- Paths --------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CREDITS_FILE = path.join(__dirname, "../credits.json");

const app = express();
app.use(cors());

// -------------------- Helpers --------------------
function isWithinScanWindow() {
  const tz = "America/New_York";
  const now = new Date();
  const hour = parseInt(new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "numeric",
    hour12: false
  }).format(now));

  const start = parseInt(process.env.SCAN_START_HOUR || "12");
  const stop = parseInt(process.env.SCAN_STOP_HOUR || "1");

  if (start < stop) return hour >= start && hour < stop;
  if (start > stop) return hour >= start || hour < stop;
  return true;
}

// -------------------- Credits --------------------
let credits = { daily: 0, monthly: 0, lastDateET: null };

function loadCredits() {
  try {
    if (fs.existsSync(CREDITS_FILE)) {
      credits = JSON.parse(fs.readFileSync(CREDITS_FILE, "utf8"));
    }
  } catch (err) {
    console.error("⚠️ Failed to load credits.json", err);
  }
}
function saveCredits() {
  try {
    fs.writeFileSync(CREDITS_FILE, JSON.stringify(credits, null, 2));
  } catch (err) {
    console.error("⚠️ Failed to save credits.json", err);
  }
}

function resetCountersIfNewDay() {
  const tz = "America/New_York";
  const now = new Date();
  const today = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(now);

  if (today !== credits.lastDateET) {
    // Send summary before reset
    if (credits.daily > 0) {
      sendTelegramMessage(
        `📊 End of Day Summary:\nDaily credits used: ${credits.daily}\nMonthly total: ${credits.monthly}`
      );
    }
    credits.lastDateET = today;
    credits.daily = 0;
    saveCredits();
    console.log(`📅 New ET day: counters reset (${today})`);
  }
}

function canUseCredits(needed) {
  const limit = parseInt(process.env.MONTHLY_CREDIT_LIMIT || "19000");
  if (credits.monthly + needed > limit) {
    const msg = `🚨 Credit safeguard triggered!\nLimit=${limit}, Current=${credits.monthly}, Need=+${needed}\n⚠️ Scans paused.`;
    console.warn(msg);
    sendTelegramMessage(msg);
    return false;
  }
  return true;
}

function addCredits(n) {
  credits.daily += n;
  credits.monthly += n;
  saveCredits();
}

// -------------------- Multi-Sport Router --------------------
const FETCHERS = {
  nfl:   { h2h: getNFLH2HNormalized, totals: getNFLTotalsNormalized, f5_h2h: getNFLF5H2HNormalized, f5_totals: getNFLF5TotalsNormalized },
  mlb:   { h2h: getMLBH2HNormalized, totals: getMLBTotalsNormalized, f5_h2h: getMLBF5H2HNormalized, f5_totals: getMLBF5TotalsNormalized },
  nba:   { h2h: getNBAH2HNormalized, totals: getNBATotalsNormalized, f5_h2h: getNBAF5H2HNormalized, f5_totals: getNBAF5TotalsNormalized },
  ncaaf: { h2h: getNCAAFH2HNormalized, totals: getNCAAFTotalsNormalized, f5_h2h: getNCAAFF5H2HNormalized, f5_totals: getNCAAFF5TotalsNormalized },
  ncaab: { h2h: getNCAABH2HNormalized, totals: getNCAABTotalsNormalized },
  tennis:{ h2h: getTennisH2HNormalized },
  soccer:{ h2h: getSoccerH2HNormalized }
};

// -------------------- Scan Endpoints --------------------
function makeScanRoute(sport, type, creditCost, fetchers) {
  app.get(`/api/${sport}/${type}_scan`, async (req, res) => {
    try {
      resetCountersIfNewDay();
      if (!isWithinScanWindow()) return res.json({ message: "Outside scan window" });
      if (!canUseCredits(creditCost)) return res.json({ message: "Monthly credit limit reached" });

      let limit = String(req.query.telegram || "").toLowerCase() === "true" ? 15 : 5;
      if (req.query.limit !== undefined) limit = Math.min(15, Math.max(1, Number(req.query.limit)));

      const h2h = await fetchers.h2h({ minHold: null });
      const totals = await fetchers.totals({ minHold: null });
      const f5h2h = fetchers.f5_h2h ? await fetchers.f5_h2h({ minHold: null }) : [];
      const f5totals = fetchers.f5_totals ? await fetchers.f5_totals({ minHold: null }) : [];

      addCredits(creditCost);
      console.log(`✅ ${sport.toUpperCase()} ${type} scan → +${creditCost} credits (daily=${credits.daily}, monthly=${credits.monthly})`);

      const compactMap = (g) => ({
        gameId: g.gameId,
        time: g.commence_time,
        home: g.home,
        away: g.away,
        market: g.market,
        best: g.best || {},
      });

      res.json({
        limit,
        h2h: (h2h || []).slice(0, limit).map(compactMap),
        totals: (totals || []).slice(0, limit).map(compactMap),
        f5_h2h: (f5h2h || []).slice(0, limit).map(compactMap),
        f5_totals: (f5totals || []).slice(0, limit).map(compactMap),
        credits_used_today: credits.daily,
        credits_used_month: credits.monthly
      });
    } catch (err) {
      console.error(`${sport} ${type}_scan error:`, err);
      sendTelegramMessage(`❌ ${sport.toUpperCase()} ${type} scan failed: ${err.message}`);
      res.status(500).json({ error: String(err) });
    }
  });
}

// Attach scan routes
makeScanRoute("mlb", "game", 2, FETCHERS.mlb);
makeScanRoute("mlb", "f5", 2, FETCHERS.mlb);
makeScanRoute("nfl", "game", 2, FETCHERS.nfl);
makeScanRoute("nfl", "f5", 2, FETCHERS.nfl);
makeScanRoute("nba", "game", 2, FETCHERS.nba);
makeScanRoute("nba", "f5", 2, FETCHERS.nba);
makeScanRoute("ncaaf", "game", 2, FETCHERS.ncaaf);
makeScanRoute("ncaaf", "f5", 2, FETCHERS.ncaaf);
makeScanRoute("ncaab", "game", 2, FETCHERS.ncaab);

// -------------------- Odds Handler --------------------
async function oddsHandler(req, res) {
  try {
    const sport = String(req.params.sport || "").toLowerCase();
    const market = String(req.params.market || "").toLowerCase();
    const raw = String(req.query.raw || "").toLowerCase() === "true";

    if (market.startsWith("prop_")) {
      const marketKey = market.replace("prop_", "");
      const data = await getPropsNormalized(sport, marketKey, {});
      return res.json(data);
    }

    if (!FETCHERS[sport] || !FETCHERS[sport][market]) {
      return res.status(400).json({ error: "unsupported", sport, market });
    }

    let data = await FETCHERS[sport][market]({ minHold: null });
    if (raw) return res.json(data);

    let limit = req.query.limit !== undefined ? Math.max(1, Number(req.query.limit)) : 10;
    const compact = String(req.query.compact || "").toLowerCase() === "true";
    if (!Array.isArray(data)) data = [];
    data = data.slice(0, limit);

    if (compact) {
      data = data.map((g) => ({
        gameId: g.gameId,
        time: g.commence_time,
        home: g.home,
        away: g.away,
        market: g.market,
        hold: typeof g.hold === "number" ? Number(g.hold.toFixed(4)) : null,
        best: g.best || {}
      }));
    }

    res.json(data);
  } catch (err) {
    console.error("oddsHandler error:", err);
    res.status(500).json({ error: String(err) });
  }
}

app.get("/api/:sport/:market", oddsHandler);

// -------------------- Startup --------------------
const PORT = process.env.PORT || 3000;
loadCredits();
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`⏱️ Scan window set to ${process.env.SCAN_START_HOUR || "12"} → ${process.env.SCAN_STOP_HOUR || "1"} ET`);
  console.log(`📊 Monthly credit safeguard set at ${process.env.MONTHLY_CREDIT_LIMIT || "19000"} credits`);
});
