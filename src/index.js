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

/* -------------------- Request Logging -------------------- */
app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    const ms = Date.now() - start;
    console.log(
      `[${new Date().toISOString()}] ${req.method} ${req.originalUrl} -> ${res.statusCode} (${ms}ms)`
    );
  });
  next();
});

/* -------------------- Health -------------------- */
app.get("/health", (_req, res) => res.json({ ok: true }));

/* -------------------- Multi-Sport Router -------------------- */

// Supported sports + their fetchers
const FETCHERS = {
  nfl:   { h2h: getNFLH2HNormalized, spreads: getNFLSpreadsNormalized, totals: getNFLTotalsNormalized },
  mlb:   { h2h: getMLBH2HNormalized, spreads: getMLBSpreadsNormalized, totals: getMLBTotalsNormalized },
  nba:   { h2h: getNBAH2HNormalized, spreads: getNBASpreadsNormalized, totals: getNBATotalsNormalized },
  ncaaf: { h2h: getNCAAFH2HNormalized, spreads: getNCAAFSpreadsNormalized, totals: getNCAAFTotalsNormalized },
  ncaab: { h2h: getNCAABH2HNormalized, spreads: getNCAABSpreadsNormalized, totals: getNCAABTotalsNormalized },
  tennis:{ h2h: getTennisH2HNormalized },
  soccer:{ h2h: getSoccerH2HNormalized }
};

// Generic handler for any sport + market
async function oddsHandler(req, res, next) {
  try {
    const sport = String(req.params.sport || "").toLowerCase();
    const market = String(req.params.market || "").toLowerCase();

    if (!FETCHERS[sport] || !FETCHERS[sport][market]) {
      return res.status(400).json({ error: "unsupported", sport, market });
    }

    const minHold = req.query.minHold !== undefined ? Number(req.query.minHold) : null;
    const limit   = req.query.limit   !== undefined ? Math.max(1, Number(req.query.limit)) : 10; // default 10
    const compact = String(req.query.compact || "").toLowerCase() === "true";

    let data = await FETCHERS[sport][market]({ minHold });
    if (!Array.isArray(data)) data = [];
    if (limit) data = data.slice(0, limit);

    if (compact) {
      data = data.map((g) => {
        const best = g.best || {};
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
    next(err);
  }
}

// Routes: /api/:sport/:market
app.get("/api/:sport/:market", oddsHandler);

/* -------------------- Global Error Handler -------------------- */
app.use((err, req, res, _next) => {
  console.error(
    `[${new Date().toISOString()}] ERROR ${req.method} ${req.originalUrl}`,
    err.stack || err.message
  );
  res.status(500).json({ error: "Internal Server Error" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
