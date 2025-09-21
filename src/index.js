// src/index.js
import "dotenv/config";
import express from "express";
import cors from "cors";

import {
  getNFLH2HNormalized, getNFLSpreadsNormalized, getNFLTotalsNormalized,
  getMLBH2HNormalized, getMLBSpreadsNormalized, getMLBTotalsNormalized,
  getNBAH2HNormalized, getNBASpreadsNormalized, getNBATotalsNormalized,
  getNCAAFH2HNormalized, getNCAAFSpreadsNormalized, getNCAAFTotalsNormalized,
  getNCAABH2HNormalized, getNCAABSpreadsNormalized, getNCAABTotalsNormalized,
  getTennisH2HNormalized,
  getSoccerH2HNormalized
} from "./odds_service.js";

const app = express();
app.use(cors());

/* -------------------- Health -------------------- */
app.get("/health", (_req, res) => res.json({ ok: true }));

/* -------------------- Multi-Sport Router -------------------- */
const FETCHERS = {
  nfl:   { h2h: getNFLH2HNormalized, spreads: getNFLSpreadsNormalized, totals: getNFLTotalsNormalized },
  mlb:   { h2h: getMLBH2HNormalized, spreads: getMLBSpreadsNormalized, totals: getMLBTotalsNormalized },
  nba:   { h2h: getNBAH2HNormalized, spreads: getNBASpreadsNormalized, totals: getNBATotalsNormalized },
  ncaaf: { h2h: getNCAAFH2HNormalized, spreads: getNCAAFSpreadsNormalized, totals: getNCAAFTotalsNormalized },
  ncaab: { h2h: getNCAABH2HNormalized, spreads: getNCAABSpreadsNormalized, totals: getNCAABTotalsNormalized },
  tennis:{ h2h: getTennisH2HNormalized },
  soccer:{ h2h: getSoccerH2HNormalized }
};

// Aliases for flexibility
const MARKET_ALIASES = {
  moneyline: "h2h",
  ml: "h2h",
  spread: "spreads",
  line: "spreads",
  overunder: "totals",
  ou: "totals",
  totals: "totals"
};

async function oddsHandler(req, res) {
  try {
    const sport = String(req.params.sport || "").toLowerCase();
    let market = String(req.params.market || "").toLowerCase();

    // Apply aliases
    if (MARKET_ALIASES[market]) {
      market = MARKET_ALIASES[market];
    }

    if (!FETCHERS[sport] || !FETCHERS[sport][market]) {
      return res.status(400).json({ error: "unsupported", sport, market });
    }

    const minHold = req.query.minHold !== undefined ? Number(req.query.minHold) : null;
    const limit   = req.query.limit !== undefined
      ? Math.max(1, Number(req.query.limit))
      : 10; // ✅ default = 10
    const compact = String(req.query.compact || "").toLowerCase() === "true";

    let data = await FETCHERS[sport][market]({ minHold });
    if (!Array.isArray(data)) data = [];

    // Always enforce limit (default or query param)
    data = data.slice(0, limit);

    if (compact) {
      data = data.map((g) => ({
        gameId: g.gameId,
        time: g.commence_time,
        home: g.home,
        away: g.away,
        market: g.market,
        hold: typeof g.hold === "number" ? Number(g.hold.toFixed(4)) : null,
        best: g.best
      }));
    }

    res.json(data);
  } catch (err) {
    console.error("oddsHandler error:", err);
    res.status(500).json({ error: String(err) });
  }
}

// Routes: /api/:sport/:market
app.get("/api/:sport/:market", oddsHandler);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
