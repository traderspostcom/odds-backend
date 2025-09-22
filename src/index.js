import "dotenv/config";
import express from "express";
import cors from "cors";
import cron from "node-cron";

import {
  // NFL
  getNFLH2HNormalized, getNFLSpreadsNormalized, getNFLTotalsNormalized,
  // MLB
  getMLBH2HNormalized, getMLBSpreadsNormalized, getMLBTotalsNormalized,
  getMLBF5H2HNormalized, getMLBF5TotalsNormalized,
  getMLBTeamTotalsNormalized, getMLBAltLinesNormalized,
  // NBA
  getNBAH2HNormalized, getNBASpreadsNormalized, getNBATotalsNormalized,
  // NCAAF
  getNCAAFH2HNormalized, getNCAAFSpreadsNormalized, getNCAAFTotalsNormalized,
  // NCAAB
  getNCAABH2HNormalized, getNCAABSpreadsNormalized, getNCAABTotalsNormalized,
  // Tennis + Soccer
  getTennisH2HNormalized, getSoccerH2HNormalized,
  // Props
  getPropsNormalized
} from "../odds_service.js";

import { sendTelegramMessage, formatSharpBatch } from "../telegram.js";
import { analyzeMarket } from "../sharpEngine.js";

const app = express();
app.use(cors());

/* -------------------- Health -------------------- */
app.get("/health", (_req, res) => res.json({ ok: true }));

/* -------------------- Multi-Sport Router -------------------- */
const FETCHERS = {
  nfl:   { h2h: getNFLH2HNormalized, spreads: getNFLSpreadsNormalized, totals: getNFLTotalsNormalized },
  mlb:   { 
    h2h: getMLBH2HNormalized, 
    spreads: getMLBSpreadsNormalized, 
    totals: getMLBTotalsNormalized,
    f5_h2h: getMLBF5H2HNormalized,
    f5_totals: getMLBF5TotalsNormalized,
    team_totals: getMLBTeamTotalsNormalized,
    alt: getMLBAltLinesNormalized
  },
  nba:   { h2h: getNBAH2HNormalized, spreads: getNBASpreadsNormalized, totals: getNBATotalsNormalized },
  ncaaf: { h2h: getNCAAFH2HNormalized, spreads: getNCAAFSpreadsNormalized, totals: getNCAAFTotalsNormalized },
  ncaab: { h2h: getNCAABH2HNormalized, spreads: getNCAABSpreadsNormalized, totals: getNCAABTotalsNormalized },
  tennis:{ h2h: getTennisH2HNormalized },
  soccer:{ h2h: getSoccerH2HNormalized }
};

/* -------------------- Telegram Alerts -------------------- */
async function handleScanAndAlerts(alerts, req = null, autoMode = false) {
  try {
    const shouldSend = autoMode || (req && String(req.query.telegram || "").toLowerCase() === "true");
    if (!shouldSend || alerts.length === 0) return;

    const formatted = formatSharpBatch(alerts);

    const now = new Date();
    const timestamp = now.toLocaleString("en-US", {
      timeZone: "America/New_York",
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
      month: "short",
      day: "numeric"
    });

    const header = `🔔 *GoSignals Batch Alert*  \n⏰ ${timestamp} ET  \nTotal: ${alerts.length}`;
    const batchMessage = [header, ...formatted].join("\n\n────────────\n\n");

    await sendTelegramMessage(batchMessage);
    console.log(`📨 Sent ${alerts.length} alerts in 1 Telegram message @ ${timestamp} ET.`);
  } catch (err) {
    console.error("❌ Error sending Telegram alerts:", err);
  }
}

/* -------------------- MLB F5 Scan -------------------- */
app.get("/api/mlb/f5_scan", async (req, res) => {
  try {
    let limit = 5;
    if (String(req.query.telegram || "").toLowerCase() === "true") limit = 15;
    if (req.query.limit !== undefined) {
      limit = Math.min(15, Math.max(1, Number(req.query.limit)));
    }

    const h2h = await FETCHERS.mlb.f5_h2h({ minHold: null });
    const totals = await FETCHERS.mlb.f5_totals({ minHold: null });

    const combined = [
      ...(Array.isArray(h2h) ? h2h.slice(0, limit) : []),
      ...(Array.isArray(totals) ? totals.slice(0, limit) : [])
    ];

    // 🔎 Run through sharp engine
    const analyzed = combined.map(a => analyzeMarket(a)).filter(a => a !== null);

    await handleScanAndAlerts(analyzed, req);
    res.json({ limit, f5_h2h: h2h, f5_totals: totals });
  } catch (err) {
    console.error("f5_scan error:", err);
    res.status(500).json({ error: String(err) });
  }
});

/* -------------------- MLB Full Game Scan -------------------- */
app.get("/api/mlb/game_scan", async (req, res) => {
  try {
    let limit = 5;
    if (String(req.query.telegram || "").toLowerCase() === "true") limit = 15;
    if (req.query.limit !== undefined) {
      limit = Math.min(15, Math.max(1, Number(req.query.limit)));
    }

    const h2h = await FETCHERS.mlb.h2h({ minHold: null });
    const totals = await FETCHERS.mlb.totals({ minHold: null });
    const spreads = await FETCHERS.mlb.spreads({ minHold: null });
    const teamTotals = await FETCHERS.mlb.team_totals({ minHold: null });

    const combined = [
      ...(Array.isArray(h2h) ? h2h.slice(0, limit) : []),
      ...(Array.isArray(totals) ? totals.slice(0, limit) : []),
      ...(Array.isArray(spreads) ? spreads.slice(0, limit) : []),
      ...(Array.isArray(teamTotals) ? teamTotals.slice(0, limit) : [])
    ];

    // 🔎 Run through sharp engine
    const analyzed = combined.map(a => analyzeMarket(a)).filter(a => a !== null);

    await handleScanAndAlerts(analyzed, req);
    res.json({ limit, h2h, totals, spreads, teamTotals });
  } catch (err) {
    console.error("game_scan error:", err);
    res.status(500).json({ error: String(err) });
  }
});

/* -------------------- Odds Handler -------------------- */
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

    // 🔎 Analyze sharp signals
    const analyzed = Array.isArray(data)
      ? data.map(a => analyzeMarket(a)).filter(a => a !== null)
      : [];

    res.json(analyzed);
  } catch (err) {
    console.error("oddsHandler error:", err);
    res.status(500).json({ error: String(err) });
  }
}
app.get("/api/:sport/:market", oddsHandler);

/* -------------------- Auto Scanning -------------------- */
cron.schedule("*/3 * * * *", async () => {
  const hourET = new Date().toLocaleString("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    hour12: false
  });
  const hour = Number(hourET);

  if (hour < process.env.SCAN_START_HOUR || hour >= process.env.SCAN_STOP_HOUR) return;

  const sports = (process.env.SCAN_SPORTS || "mlb").split(",").map(s => s.trim().toLowerCase());
  for (const sport of sports) {
    try {
      const url = `https://odds-backend-oo4k.onrender.com/api/${sport}/f5_scan?telegram=true`;
      const res = await fetch(url);
      const data = await res.json();

      const betCount = Array.isArray(data) ? data.length : 0;
      if (betCount > 0) {
        console.log(`✅ Auto-scan ran for ${sport}, found ${betCount} bets`);
      }
    } catch (err) {
      console.error(`❌ Auto-scan failed for ${sport}:`, err);
    }
  }
});

/* -------------------- Start Server -------------------- */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
