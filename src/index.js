// src/index.js
import "dotenv/config";
import express from "express";
import cors from "cors";

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

/* -------------------- Test Odds Alert -------------------- */
app.get("/api/test/odds", async (_req, res) => {
  try {
    const fakeGame = {
      gameId: "test123",
      time: "Jan 19 • 8:00 PM ET",
      home: "Boston Celtics",
      away: "Detroit Pistons",
      market: "spreads",
      best: {
        FAV: { book: "DraftKings", point: -4.5, price: -110 },
        DOG: { book: "DraftKings", point: +4.5, price: -110 }
      }
    };

    const message = formatSharpAlert(fakeGame, fakeGame.market);
    await sendTelegramMessage(message);

    res.json({ ok: true, msg: "Test odds alert sent to Telegram" });
  } catch (err) {
    console.error("test/odds error:", err);
    res.status(500).json({ error: String(err) });
  }
});

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

    const minHold = req.query.minHold !== undefined ? Number(req.query.minHold) : null;
    const limit   = req.query.limit   !== undefined ? Math.max(1, Number(req.query.limit)) : 10;
    const compact = String(req.query.compact || "").toLowerCase() === "true";

    let data = await FETCHERS[sport][market]({ minHold });

    if (!Array.isArray(data)) data = [];
    if (limit) data = data.slice(0, limit);

    if (compact) {
      data = data.map((g) => ({
        gameId: g.gameId,
        time: g.commence_time,
        home: g.home,
        away: g.away,
        market: g.market,
        hold: typeof g.hold === "number" ? Number(g.hold.toFixed(4)) : null,
        best: g.best || {}
      }));
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
