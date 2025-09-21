// src/index.js
import "dotenv/config";
import express from "express";
import cors from "cors";
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

  // Generic props
  getPropsNormalized
} from "../odds_service.js";   // ✅ odds_service.js is in root

const app = express();
app.use(cors());

/* -------------------- Telegram Setup -------------------- */
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const TELEGRAM_URL = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;

async function sendTelegramMessage(text) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await fetch(TELEGRAM_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text,
        parse_mode: "Markdown"
      })
    });
  } catch (err) {
    console.error("❌ Telegram send error:", err);
  }
}

/* -------------------- Sharp Detector -------------------- */
const SHARP_HOLD_MAX = parseFloat(process.env.SHARP_HOLD_MAX || "0.02");
const SHARP_BOOKS = (process.env.SHARP_BOOKS || "pinnacle,betfair").split(",").map(b => b.toLowerCase());
const SHARP_ALERTS = (process.env.SHARP_ALERTS || "true").toLowerCase() === "true";

function isSharpSignal(game) {
  if (!SHARP_ALERTS || !game.hold || !game.best) return false;
  if (game.hold > SHARP_HOLD_MAX) return false;

  const bestBooks = Object.values(game.best).map(b => (b.book || "").toLowerCase());
  return bestBooks.some(bk => SHARP_BOOKS.includes(bk));
}

function formatSharpAlert(g) {
  const lines = [];
  lines.push(`🚨 *Sharp Alert* 🚨`);
  lines.push(`${g.away} @ ${g.home}`);
  lines.push(`Market: ${g.market.toUpperCase()}`);
  lines.push(`Hold: ${(g.hold * 100).toFixed(2)}%`);
  if (g.best) {
    for (const [side, b] of Object.entries(g.best)) {
      lines.push(`${side.toUpperCase()}: ${b.price} (${b.book}${b.point ? ` ${b.point}` : ""})`);
    }
  }
  return lines.join("\n");
}

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

    let h2hLimited = Array.isArray(h2h) ? h2h.slice(0, limit) : [];
    let totalsLimited = Array.isArray(totals) ? totals.slice(0, limit) : [];

    const compactMap = (g) => ({
      gameId: g.gameId,
      time: g.commence_time,
      home: g.home,
      away: g.away,
      market: g.market,
      hold: g.hold,
      best: g.best || {},
    });

    const result = { limit, f5_h2h: h2hLimited.map(compactMap), f5_totals: totalsLimited.map(compactMap) };

    // 🔔 Send sharp alerts
    [...h2hLimited, ...totalsLimited].forEach(g => {
      if (isSharpSignal(g)) {
        sendTelegramMessage(formatSharpAlert(g));
      }
    });

    res.json(result);
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

    let h2hLimited = Array.isArray(h2h) ? h2h.slice(0, limit) : [];
    let totalsLimited = Array.isArray(totals) ? totals.slice(0, limit) : [];
    let spreadsLimited = Array.isArray(spreads) ? spreads.slice(0, limit) : [];
    let teamTotalsLimited = Array.isArray(teamTotals) ? teamTotals.slice(0, limit) : [];

    const compactMap = (g) => ({
      gameId: g.gameId,
      time: g.commence_time,
      home: g.home,
      away: g.away,
      market: g.market,
      hold: g.hold,
      best: g.best || {},
    });

    const result = {
      limit,
      game_h2h: h2hLimited.map(compactMap),
      game_totals: totalsLimited.map(compactMap),
      game_spreads: spreadsLimited.map(compactMap),
      game_team_totals: teamTotalsLimited.map(compactMap)
    };

    // 🔔 Send sharp alerts
    [...h2hLimited, ...totalsLimited, ...spreadsLimited, ...teamTotalsLimited].forEach(g => {
      if (isSharpSignal(g)) {
        sendTelegramMessage(formatSharpAlert(g));
      }
    });

    res.json(result);
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

/* -------------------- Routes -------------------- */
app.get("/api/:sport/:market", oddsHandler);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
