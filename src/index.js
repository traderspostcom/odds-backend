import "dotenv/config";
import express from "express";
import cors from "cors";
import cron from "node-cron";
import fetch from "node-fetch";

import config from "../config.js";

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

/* -------------------- Sharp Filter -------------------- */
function filterForSharps(games) {
  return games.filter((g) => {
    if (typeof g.tickets !== "number" || typeof g.handle !== "number") return false;
    return g.tickets <= 40 && (g.handle - g.tickets) >= 10;
  });
}

/* -------------------- Telegram Alerts -------------------- */
async function handleScanAndAlerts(alerts, req = null, autoMode = false) {
  try {
    const shouldSend = autoMode || (req && String(req.query.telegram || "").toLowerCase() === "true");
    if (!shouldSend || alerts.length === 0) return;

    let finalAlerts = alerts;
    let modeLabel = "ALL";

    if (String(process.env.SHARPS_ONLY || "").toLowerCase() === "true") {
      finalAlerts = filterForSharps(alerts);
      modeLabel = "SHARPS_ONLY";
    }

    if (finalAlerts.length > 0) {
      const formatted = formatSharpBatch(finalAlerts);

      const now = new Date();
      const timestamp = now.toLocaleString("en-US", {
        timeZone: "America/New_York",
        hour: "numeric",
        minute: "2-digit",
        second: "2-digit",
        month: "short",
        day: "numeric"
      });

      const header = `🔔 *GoSignals Batch Alert*  \n_Mode: ${modeLabel}_  \n⏰ ${timestamp} ET  \nTotal: ${finalAlerts.length}`;
      const batchMessage = [header, ...formatted].join("\n\n────────────\n\n");

      await sendTelegramMessage(batchMessage);
      console.log(`📨 Sent ${finalAlerts.length} ${modeLabel} alerts @ ${timestamp} ET.`);
    }
  } catch (err) {
    console.error("❌ Error sending Telegram alerts:", err);
  }
}

/* -------------------- Scan Builders -------------------- */
function buildScanRoute(sportKey, type = "game") {
  const route = `/api/${sportKey}/${type}_scan`;

  app.get(route, async (req, res) => {
    try {
      let markets = [];

      if (sportKey === "mlb" && type === "f5") {
        markets = [
          ...(await FETCHERS.mlb.f5_h2h({ minHold: null }) || []),
          ...(await FETCHERS.mlb.f5_totals({ minHold: null }) || [])
        ];
      } else {
        markets = [
          ...(await FETCHERS[sportKey].h2h({ minHold: null }) || []),
          ...(await FETCHERS[sportKey].totals({ minHold: null }) || []),
          ...(await FETCHERS[sportKey].spreads({ minHold: null }) || [])
        ];
      }

      await handleScanAndAlerts(markets, req);
      res.json({ markets });
    } catch (err) {
      console.error(`${route} error:`, err);
      res.status(500).json({ error: String(err) });
    }
  });
}

/* -------------------- Build Routes -------------------- */
// MLB
if (config.sports.mlb.f5) buildScanRoute("mlb", "f5");
if (config.sports.mlb.full) buildScanRoute("mlb", "game");

// NFL
if (config.sports.nfl.full) buildScanRoute("nfl", "game");
if (config.sports.nfl.h1)   buildScanRoute("nfl", "h1");

// NCAAF
if (config.sports.ncaaf.full) buildScanRoute("ncaaf", "game");
if (config.sports.ncaaf.h1)   buildScanRoute("ncaaf", "h1");

// NBA
if (config.sports.nba.full) buildScanRoute("nba", "game");
if (config.sports.nba.h1)   buildScanRoute("nba", "h1");

// NCAAB
if (config.sports.ncaab.full) buildScanRoute("ncaab", "game");
if (config.sports.ncaab.h1)   buildScanRoute("ncaab", "h1");

/* -------------------- Odds Handler -------------------- */
async function oddsHandler(req, res) {
  try {
    const sport = String(req.params.sport || "").toLowerCase();
    const market = String(req.params.market || "").toLowerCase();

    if (market.startsWith("prop_")) {
      const marketKey = market.replace("prop_", ""); 
      const data = await getPropsNormalized(sport, marketKey, {});
      return res.json(data);
    }

    if (!FETCHERS[sport] || !FETCHERS[sport][market]) {
      return res.status(400).json({ error: "unsupported", sport, market });
    }

    let data = await FETCHERS[sport][market]({ minHold: null });
    if (!Array.isArray(data)) data = [];

    res.json(data);
  } catch (err) {
    console.error("oddsHandler error:", err);
    res.status(500).json({ error: String(err) });
  }
}
app.get("/api/:sport/:market", oddsHandler);

/* -------------------- Auto Scanning -------------------- */
cron.schedule(`*/${config.scan.intervalMinutes} * * * *`, async () => {
  const hourET = new Date().toLocaleString("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    hour12: false
  });
  const hour = Number(hourET);

  if (hour < config.scan.startHourET || hour >= config.scan.stopHourET) return;

  const jobs = [];

  if (config.sports.mlb.f5)   jobs.push({ sport: "mlb", path: "f5_scan" });
  if (config.sports.mlb.full) jobs.push({ sport: "mlb", path: "game_scan" });

  if (config.sports.nfl.full) jobs.push({ sport: "nfl", path: "game_scan" });
  if (config.sports.nfl.h1)   jobs.push({ sport: "nfl", path: "h1_scan" });

  if (config.sports.ncaaf.full) jobs.push({ sport: "ncaaf", path: "game_scan" });
  if (config.sports.ncaaf.h1)   jobs.push({ sport: "ncaaf", path: "h1_scan" });

  if (config.sports.nba.full) jobs.push({ sport: "nba", path: "game_scan" });
  if (config.sports.nba.h1)   jobs.push({ sport: "nba", path: "h1_scan" });

  if (config.sports.ncaab.full) jobs.push({ sport: "ncaab", path: "game_scan" });
  if (config.sports.ncaab.h1)   jobs.push({ sport: "ncaab", path: "h1_scan" });

  for (const job of jobs) {
    try {
      const url = `https://odds-backend-oo4k.onrender.com/api/${job.sport}/${job.path}?telegram=true`;
      const res = await fetch(url);
      const data = await res.json();

      const betCount = Object.values(data)
        .filter((x) => Array.isArray(x))
        .reduce((sum, arr) => sum + arr.length, 0);

      if (betCount > 0) {
        console.log(`✅ Auto-scan ran for ${job.sport} (${job.path}), found ${betCount} bets`);
      }
    } catch (err) {
      console.error(`❌ Auto-scan failed for ${job.sport} (${job.path}):`, err);
    }
  }
});

/* -------------------- Daily Config Summary -------------------- */
cron.schedule("0 0 * * *", async () => {
  try {
    const lines = [];

    for (const [sport, opts] of Object.entries(config.sports)) {
      const active = [];
      if (opts.f5) active.push("F5");
      if (opts.full) active.push("Full");
      if (opts.h1) active.push("H1");

      if (active.length > 0) {
        lines.push(`- *${sport.toUpperCase()}*: ${active.join(", ")}`);
      }
    }

    const now = new Date();
    const dateET = now.toLocaleDateString("en-US", { timeZone: "America/New_York" });

    const summary = `📊 *GoSignals Daily Summary* \n📅 ${dateET} (ET)\n\nActive Scans:\n${lines.join("\n")}`;
    await sendTelegramMessage(summary);
    console.log("✅ Daily summary sent to Telegram");
  } catch (err) {
    console.error("❌ Failed to send daily summary:", err);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
