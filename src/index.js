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

  // Generic props
  getPropsNormalized
} from "../odds_service.js";

import { sendTelegramMessage, formatSharpAlert } from "../telegram.js";

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

    const h2hLimited = Array.isArray(h2h) ? h2h.slice(0, limit) : [];
    const totalsLimited = Array.isArray(totals) ? totals.slice(0, limit) : [];

    // Send Telegram alert if requested
    if (String(req.query.telegram || "").toLowerCase() === "true") {
      for (const g of [...h2hLimited, ...totalsLimited]) {
        const message = formatSharpAlert(g, g.market || "f5");
        await sendTelegramMessage(message);
      }
    }

    res.json({ limit, f5_h2h: h2hLimited, f5_totals: totalsLimited });
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

    const h2hLimited = Array.isArray(h2h) ? h2h.slice(0, limit) : [];
    const totalsLimited = Array.isArray(totals) ? totals.slice(0, limit) : [];
    const spreadsLimited = Array.isArray(spreads) ? spreads.slice(0, limit) : [];
    const teamTotalsLimited = Array.isArray(teamTotals) ? teamTotals.slice(0, limit) : [];

    // Send Telegram alert if requested
    if (String(req.query.telegram || "").toLowerCase() === "true") {
      for (const g of [...h2hLimited, ...totalsLimited, ...spreadsLimited, ...teamTotalsLimited]) {
        const message = formatSharpAlert(g, g.market || "game");
        await sendTelegramMessage(message);
      }
    }

    res.json({
      limit,
      game_h2h: h2hLimited,
      game_totals: totalsLimited,
      game_spreads: spreadsLimited,
      game_team_totals: teamTotalsLimited
    });
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

/* -------------------- Telegram Test -------------------- */
app.get("/api/test/telegram", async (_req, res) => {
  try {
    const message = "✅ Test message from GoSignals backend! 📊";
    await sendTelegramMessage(message);
    res.json({ ok: true, sent: message });
  } catch (err) {
    console.error("❌ Telegram test failed:", err);
    res.status(500).json({ error: String(err) });
  }
});

/* -------------------- Routes -------------------- */
app.get("/api/:sport/:market", oddsHandler);

/* -------------------- Auto Scanning -------------------- */
cron.schedule("*/30 * * * * *", async () => {
  const now = new Date();
  const hour = now.getUTCHours() - 4; // crude UTC→ET shift

  if (hour < process.env.SCAN_START_HOUR || hour >= process.env.SCAN_STOP_HOUR) {
    return; // outside scan window
  }

  try {
    const res = await fetch(
      `https://odds-backend-oo4k.onrender.com/api/mlb/f5_scan?telegram=true`
    );
    console.log("✅ Auto-scan triggered, Telegram alerts sent");
  } catch (err) {
    console.error("❌ Auto-scan failed:", err);
  }
});

/* -------------------- Start Server -------------------- */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
