// src/index.js
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

const app = express();
app.use(cors());

/* -------------------- Health -------------------- */
app.get("/health", (_req, res) => res.json({ ok: true }));

/* -------------------- Fetchers -------------------- */
const FETCHERS = {
  nfl:   { h2h: getNFLH2HNormalized, spreads: getNFLSpreadsNormalized, totals: getNFLTotalsNormalized },
  mlb:   { 
    h2h: getMLBH2HNormalized, spreads: getMLBSpreadsNormalized, totals: getMLBTotalsNormalized,
    f5_h2h: getMLBF5H2HNormalized, f5_totals: getMLBF5TotalsNormalized,
    team_totals: getMLBTeamTotalsNormalized, alt: getMLBAltLinesNormalized
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
async function handleScanAndAlerts(alerts, req = null, autoMode = false, label = "") {
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

      const header = `🔔 *GoSignals Batch Alert – ${label}*  \n_Mode: ${modeLabel}_  \n⏰ ${timestamp} ET  \nTotal: ${finalAlerts.length}`;
      const batchMessage = [header, ...formatted].join("\n\n────────────\n\n");

      await sendTelegramMessage(batchMessage);
      console.log(`📨 Sent ${finalAlerts.length} ${modeLabel} alerts for ${label} @ ${timestamp} ET.`);
    } else {
      console.log(`⏸ No sharp alerts for ${label}`);
    }
  } catch (err) {
    console.error("❌ Error sending Telegram alerts:", err);
  }
}

/* -------------------- Helper: Run Scan -------------------- */
async function runScan(sport, markets, req = null, autoMode = false, label = "") {
  let results = [];
  for (const m of markets) {
    if (!FETCHERS[sport][m]) continue;
    const data = await FETCHERS[sport][m]({ minHold: null });
    if (Array.isArray(data)) results = results.concat(data);
  }
  await handleScanAndAlerts(results, req, autoMode, label);
  return results;
}

/* -------------------- Stub Routes -------------------- */
// MLB
app.get("/api/mlb/f5_scan", (req, res) => runScan("mlb", ["f5_h2h", "f5_totals"], req, false, "MLB F5").then(data => res.json(data)));
app.get("/api/mlb/full_scan", (req, res) => runScan("mlb", ["h2h","spreads","totals","team_totals","alt"], req, false, "MLB Full").then(data => res.json(data)));

// NFL
app.get("/api/nfl/h1_scan", (req, res) => runScan("nfl", ["spreads","totals"], req, false, "NFL H1").then(data => res.json(data)));
app.get("/api/nfl/full_scan", (req, res) => runScan("nfl", ["h2h","spreads","totals"], req, false, "NFL Full").then(data => res.json(data)));

// NCAAF
app.get("/api/ncaaf/h1_scan", (req, res) => runScan("ncaaf", ["spreads","totals"], req, false, "NCAAF H1").then(data => res.json(data)));
app.get("/api/ncaaf/full_scan", (req, res) => runScan("ncaaf", ["h2h","spreads","totals"], req, false, "NCAAF Full").then(data => res.json(data)));

// NBA
app.get("/api/nba/h1_scan", (req, res) => runScan("nba", ["spreads","totals"], req, false, "NBA H1").then(data => res.json(data)));
app.get("/api/nba/full_scan", (req, res) => runScan("nba", ["h2h","spreads","totals"], req, false, "NBA Full").then(data => res.json(data)));

// NCAAB
app.get("/api/ncaab/h1_scan", (req, res) => runScan("ncaab", ["spreads","totals"], req, false, "NCAAB H1").then(data => res.json(data)));
app.get("/api/ncaab/full_scan", (req, res) => runScan("ncaab", ["h2h","spreads","totals"], req, false, "NCAAB Full").then(data => res.json(data)));

// Tennis & Soccer (manual only)
app.get("/api/tennis/h2h_scan", (req, res) => runScan("tennis", ["h2h"], req, false, "Tennis H2H").then(data => res.json(data)));
app.get("/api/soccer/h2h_scan", (req, res) => runScan("soccer", ["h2h"], req, false, "Soccer H2H").then(data => res.json(data)));

/* -------------------- Auto Scanning -------------------- */
cron.schedule(`*/${process.env.SCAN_INTERVAL || 3} * * * *`, async () => {
  const hourET = new Date().toLocaleString("en-US", {
    timeZone: "America/New_York", hour: "numeric", hour12: false
  });
  const hour = Number(hourET);

  if (hour < process.env.SCAN_START_HOUR || hour >= process.env.SCAN_STOP_HOUR) {
    console.log("⏸ Outside scan window, skipping...");
    return;
  }

  const sports = (process.env.SCAN_SPORTS || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);

  for (const sport of sports) {
    if (sport === "mlb") {
      if (process.env.SCAN_MLB_F5 === "true") await runScan("mlb", ["f5_h2h","f5_totals"], null, true, "MLB F5");
      else console.log("⏸ MLB F5 scan disabled via env");

      if (process.env.SCAN_MLB_FULL === "true") await runScan("mlb", ["h2h","spreads","totals","team_totals","alt"], null, true, "MLB Full");
      else console.log("⏸ MLB Full scan disabled via env");
    }

    if (sport === "nfl") {
      if (process.env.SCAN_NFL_H1 === "true") await runScan("nfl", ["spreads","totals"], null, true, "NFL H1");
      else console.log("⏸ NFL H1 scan disabled via env");

      if (process.env.SCAN_NFL_FULL === "true") await runScan("nfl", ["h2h","spreads","totals"], null, true, "NFL Full");
      else console.log("⏸ NFL Full scan disabled via env");
    }

    if (sport === "ncaaf") {
      if (process.env.SCAN_NCAAF_H1 === "true") await runScan("ncaaf", ["spreads","totals"], null, true, "NCAAF H1");
      else console.log("⏸ NCAAF H1 scan disabled via env");

      if (process.env.SCAN_NCAAF_FULL === "true") await runScan("ncaaf", ["h2h","spreads","totals"], null, true, "NCAAF Full");
      else console.log("⏸ NCAAF Full scan disabled via env");
    }

    if (sport === "nba") {
      if (process.env.SCAN_NBA_H1 === "true") await runScan("nba", ["spreads","totals"], null, true, "NBA H1");
      else console.log("⏸ NBA H1 scan disabled via env");

      if (process.env.SCAN_NBA_FULL === "true") await runScan("nba", ["h2h","spreads","totals"], null, true, "NBA Full");
      else console.log("⏸ NBA Full scan disabled via env");
    }

    if (sport === "ncaab") {
      if (process.env.SCAN_NCAAB_H1 === "true") await runScan("ncaab", ["spreads","totals"], null, true, "NCAAB H1");
      else console.log("⏸ NCAAB H1 scan disabled via env");

      if (process.env.SCAN_NCAAB_FULL === "true") await runScan("ncaab", ["h2h","spreads","totals"], null, true, "NCAAB Full");
      else console.log("⏸ NCAAB Full scan disabled via env");
    }
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
