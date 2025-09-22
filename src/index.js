import "dotenv/config";
import express from "express";
import cors from "cors";
import cron from "node-cron";
import fetch from "node-fetch";

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
      console.log(`📨 Sent ${finalAlerts.length} ${modeLabel} alerts in 1 Telegram message @ ${timestamp} ET.`);
    }
  } catch (err) {
    console.error("❌ Error sending Telegram alerts:", err);
  }
}

/* -------------------- MLB Routes -------------------- */
app.get("/api/mlb/f5_scan", async (req, res) => {
  try {
    const h2h = await FETCHERS.mlb.f5_h2h({ minHold: null });
    const totals = await FETCHERS.mlb.f5_totals({ minHold: null });
    const combined = [...(h2h || []), ...(totals || [])];

    await handleScanAndAlerts(combined, req);
    res.json({ f5_h2h: h2h, f5_totals: totals });
  } catch (err) {
    console.error("f5_scan error:", err);
    res.status(500).json({ error: String(err) });
  }
});

app.get("/api/mlb/game_scan", async (req, res) => {
  try {
    const h2h = await FETCHERS.mlb.h2h({ minHold: null });
    const totals = await FETCHERS.mlb.totals({ minHold: null });
    const spreads = await FETCHERS.mlb.spreads({ minHold: null });
    const teamTotals = await FETCHERS.mlb.team_totals({ minHold: null });
    const combined = [...(h2h || []), ...(totals || []), ...(spreads || []), ...(teamTotals || [])];

    await handleScanAndAlerts(combined, req);
    res.json({ h2h, totals, spreads, team_totals: teamTotals });
  } catch (err) {
    console.error("game_scan error:", err);
    res.status(500).json({ error: String(err) });
  }
});

/* -------------------- NFL / NCAAF / NBA / NCAAB Routes -------------------- */
function buildGameScanRoute(sportKey) {
  app.get(`/api/${sportKey}/game_scan`, async (req, res) => {
    try {
      const h2h = await FETCHERS[sportKey].h2h({ minHold: null });
      const totals = await FETCHERS[sportKey].totals({ minHold: null });
      const spreads = await FETCHERS[sportKey].spreads({ minHold: null });
      const combined = [...(h2h || []), ...(totals || []), ...(spreads || [])];

      await handleScanAndAlerts(combined, req);
      res.json({ h2h, totals, spreads });
    } catch (err) {
      console.error(`${sportKey} game_scan error:`, err);
      res.status(500).json({ error: String(err) });
    }
  });
}

["nfl", "ncaaf", "nba", "ncaab"].forEach(buildGameScanRoute);

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

    if (!Array.isArray(data)) data = [];
    res.json(data);
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

  const jobs = [
    { sport: "mlb", path: "f5_scan" },
    { sport: "mlb", path: "game_scan" },
    { sport: "nfl", path: "game_scan" },
    { sport: "ncaaf", path: "game_scan" },
    { sport: "nba", path: "game_scan" },
    { sport: "ncaab", path: "game_scan" }
  ];

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
    const sports = (process.env.SCAN_SPORTS || "mlb")
      .split(",")
      .map((s) => s.trim().toLowerCase());

    const lines = [];
    for (const sport of sports) {
      const envKey = `SCAN_${sport.toUpperCase()}_MARKETS`;
      const markets = (process.env[envKey] || "")
        .split(",")
        .map((m) => m.trim().toLowerCase())
        .filter((m) => m);

      if (markets.length > 0) {
        lines.push(`- *${sport.toUpperCase()}*: ${markets.join(", ")}`);
      } else {
        lines.push(`- *${sport.toUpperCase()}*: (no markets configured)`);
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
