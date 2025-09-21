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

async function oddsHandler(req, res) {
  try {
    const sport = String(req.params.sport || "").toLowerCase();
    const market = String(req.params.market || "").toLowerCase();

    if (!FETCHERS[sport] || !FETCHERS[sport][market]) {
      return res.status(400).json({ error: "unsupported", sport, market });
    }

    const minHold = req.query.minHold !== undefined ? Number(req.query.minHold) : null;
    let limit = req.query.limit !== undefined ? Math.max(1, Number(req.query.limit)) : null;
    if (!limit) limit = 10; // ✅ Default to 10

    const compact = String(req.query.compact || "").toLowerCase() === "true";

    let data = await FETCHERS[sport][market]({ minHold });
    if (!Array.isArray(data)) data = [];
    if (limit) data = data.slice(0, limit);

    if (compact) {
      data = data.map((g) => {
        const best = g.best || {};
        let formattedBest = {};

        if (market === "h2h") {
          // Show as home vs away
          formattedBest = {
            home: best[g.home] ? { book: best[g.home].book, price: best[g.home].price } : null,
            away: best[g.away] ? { book: best[g.away].book, price: best[g.away].price } : null
          };
        }

        if (market === "spreads") {
          // Sort spreads: favorite (more negative) vs underdog
          const sides = Object.values(best).filter(Boolean);
          const favorite = sides.sort((a, b) => (a.point ?? 0) - (b.point ?? 0))[0];
          const underdog = sides.find(s => s !== favorite);

          formattedBest = {
            FAV: favorite ? { book: favorite.book, price: favorite.price, point: favorite.point } : null,
            DOG: underdog ? { book: underdog.book, price: underdog.price, point: underdog.point } : null
          };
        }

        if (market === "totals") {
          // Always O then U
          formattedBest = {
            O: best["sideA"] && best["sideA"].point !== undefined
              ? { book: best["sideA"].book, price: best["sideA"].price, point: best["sideA"].point }
              : null,
            U: best["sideB"] && best["sideB"].point !== undefined
              ? { book: best["sideB"].book, price: best["sideB"].price, point: best["sideB"].point }
              : null
          };
        }

        return {
          gameId: g.gameId,
          time: g.commence_time,
          home: g.home,
          away: g.away,
          market: g.market,
          hold: typeof g.hold === "number" ? Number(g.hold.toFixed(4)) : null,
          best: formattedBest
        };
      });
    }

    res.json(data);
  } catch (err) {
    console.error("oddsHandler error:", err);
    res.status(500).json({ error: String(err) });
  }
}

app.get("/api/:sport/:market", oddsHandler);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
