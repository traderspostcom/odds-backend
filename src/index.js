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

/* -------------------- Sharp Classifier -------------------- */
function classifySharps(games) {
  return games.map((g) => {
    if (typeof g.tickets !== "number" || typeof g.handle !== "number") {
      return { ...g, sharpLevel: null };
    }

    const gap = g.handle - g.tickets;

    if (g.tickets <= 40 && gap >= 10) {
      return { ...g, sharpLevel: "strong" }; // 🟢 Strong
    } else if (g.tickets <= 50 && gap >= 5) {
      return { ...g, sharpLevel: "lean" };   // 🟡 Lean
    }

    return { ...g, sharpLevel: null }; // no sharp edge
  });
}

/* -------------------- Telegram Alerts -------------------- */
async function handleScanAndAlerts(alerts, req = null, autoMode = false) {
  try {
    const shouldSend =
      autoMode || (req && String(req.query.telegram || "").toLowerCase() === "true");
    if (!shouldSend || alerts.length === 0) return;

    let finalAlerts = classifySharps(alerts).filter((g) => g.sharpLevel);

    if (finalAlerts.length > 0) {
      // inject label into games before formatting
      finalAlerts = finalAlerts.map((g) => {
        const sharpLabel = g.sharpLevel === "strong" ? "🟢 Strong" : "🟡 Lean";
        return { ...g, sharpLabel };
      });

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

      const header = `🔔 *GoSignals Sharp Alert Batch*  
⏰ ${timestamp} ET  
Total: ${finalAlerts.length}`;
      const batchMessage = [header, ...formatted].join("\n\n────────────\n\n");

      await sendTelegramMessage(batchMessage);
      console.log(
        `📨 Sent ${finalAlerts.length} sharp alerts in 1 Telegram message @ ${timestamp} ET.`
      );
    }
  } catch (err) {
    console.error("❌ Error sending Telegram alerts:", err);
  }
}

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

    const minHold = req.query.minHold !== undefined ? Number(req.query.minHold) : null;
    const limit   = req.query.limit   !== undefined ? Math.max(1, Number(req.query.limit)) : 10;
    const compact = String(req.query.compact || "").toLowerCase() === "true";

    let data = await FETCHERS[sport][market]({ minHold });
    if (raw) return res.json(data);

    if (!Array.isArray(data)) data = [];
    if (limit) data = data.slice(0, limit);

    if (compact) {
      data = data.map((g) => {
        const best  = g.best || {};
        return {
          gameId: g.gameId,
          time: g.commence_time,
          home: g.home,
          away: g.away,
          market: g.market,
          hold: typeof g.hold === "number" ? Number(g.hold.toFixed(4)) : null,
          tickets: g.tickets ?? null,
          handle: g.handle ?? null,
          best
        };
      });
    }

    res.json(data);
  } catch (err) {
    console.error("oddsHandler error:", err);
    res.status(500).json({ error: String(err) });
  }
}

/* -------------------- Routes -------------------- */
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

  const sports = (process.env.SCAN_SPORTS || "mlb")
    .split(",")
    .map((s) => s.trim().toLowerCase());

  for (const sport of sports) {
    const envKey = `SCAN_${sport.toUpperCase()}_MARKETS`;
    const markets = (process.env[envKey] || "")
      .split(",")
      .map((m) => m.trim().toLowerCase())
      .filter((m) => m);

    for (const market of markets) {
      try {
        const url = `https://odds-backend-oo4k.onrender.com/api/${sport}/${market}?telegram=true`;
        const res = await fetch(url);
        const data = await res.json();

        const betCount = Object.values(data)
          .filter((x) => Array.isArray(x))
          .reduce((sum, arr) => sum + arr.length, 0);

        if (betCount > 0) {
          console.log(`✅ Auto-scan ran for ${sport} (${market}), found ${betCount} bets`);
        }
      } catch (err) {
        console.error(`❌ Auto-scan failed for ${sport} (${market}):`, err);
      }
    }
  }
});

/* -------------------- Daily Summary -------------------- */
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
    const dateET = now.toLocaleDateString("en-US", {
      timeZone: "America/New_York"
    });

    const summary = `📊 *GoSignals Daily Summary* 
📅 ${dateET} (ET)\n\nActive Scans:\n${lines.join("\n")}`;

    await sendTelegramMessage(summary);
    console.log("✅ Daily summary sent to Telegram");
  } catch (err) {
    console.error("❌ Failed to send daily summary:", err);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`✅ Server running on port ${PORT}`)
);
