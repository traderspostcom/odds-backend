// index.js
import "dotenv/config";
import express from "express";
import cors from "cors";

import {
  // NFL
  getNFLH2HNormalized, getNFLSpreadsNormalized, getNFLTotalsNormalized,
  // MLB
  getMLBH2HNormalized, getMLBSpreadsNormalized, getMLBTotalsNormalized,
  getMLBF5Normalized, getMLBF5TotalsNormalized,
  getMLBTeamTotalsNormalized, getMLBAltLinesNormalized,
  // NBA
  getNBAH2HNormalized, getNBASpreadsNormalized, getNBATotalsNormalized,
  // NCAAF
  getNCAAFH2HNormalized, getNCAAFSpreadsNormalized, getNCAAFTotalsNormalized,
  // NCAAB
  getNCAABH2HNormalized, getNCAABSpreadsNormalized, getNCAABTotalsNormalized,
  // Tennis
  getTennisH2HNormalized,
  // Soccer
  getSoccerH2HNormalized,
  // Generic Props
  getPropsNormalized
} from "./odds_service.js";   // adjust if file path differs

const app = express();
app.use(cors());

/* -------------------- Health -------------------- */
app.get("/health", (_req, res) => res.json({ ok: true }));

/* -------------------- Multi-Sport Router -------------------- */

const FETCHERS = {
  nfl: {
    h2h: getNFLH2HNormalized,
    spreads: getNFLSpreadsNormalized,
    totals: getNFLTotalsNormalized,
  },
  mlb: {
    h2h: getMLBH2HNormalized,
    spreads: getMLBSpreadsNormalized,
    totals: getMLBTotalsNormalized,
    f5: getMLBF5Normalized,
    f5totals: getMLBF5TotalsNormalized,
    teamtotals: getMLBTeamTotalsNormalized,
    altlines: getMLBAltLinesNormalized,
  },
  nba: {
    h2h: getNBAH2HNormalized,
    spreads: getNBASpreadsNormalized,
    totals: getNBATotalsNormalized,
  },
  ncaaf: {
    h2h: getNCAAFH2HNormalized,
    spreads: getNCAAFSpreadsNormalized,
    totals: getNCAAFTotalsNormalized,
  },
  ncaab: {
    h2h: getNCAABH2HNormalized,
    spreads: getNCAABSpreadsNormalized,
    totals: getNCAABTotalsNormalized,
  },
  tennis: { h2h: getTennisH2HNormalized },
  soccer: { h2h: getSoccerH2HNormalized },
};

// Generic odds handler
async function oddsHandler(req, res) {
  try {
    const sport = String(req.params.sport || "").toLowerCase();
    const market = String(req.params.market || "").toLowerCase();

    let fn = FETCHERS[sport]?.[market];

    // fallback: treat as a prop market
    if (!fn) {
      fn = (opts) => getPropsNormalized(sport, market, opts);
    }

    const minHold = req.query.minHold !== undefined ? Number(req.query.minHold) : null;
    const limit   = req.query.limit !== undefined ? Math.max(1, Number(req.query.limit)) : 10;
    const compact = String(req.query.compact || "").toLowerCase() === "true";

    let data = await fn({ minHold });
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

// Routes
app.get("/api/:sport/:market", oddsHandler);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
