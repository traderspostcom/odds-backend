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
/* -------------------- Auto Scanner -------------------- */
const SCAN_START_HOUR = Number(process.env.SCAN_START_HOUR || 7);   // default 7 AM ET
const SCAN_STOP_HOUR  = Number(process.env.SCAN_STOP_HOUR || 23);  // default 11 PM ET
const SCAN_SPORTS = (process.env.SCAN_SPORTS || "mlb").split(",");

async function runScans() {
  const now = new Date();
  const hourET = now.getUTCHours() - 4; // crude ET conversion (UTC-4, adjust DST if needed)

  if (hourET < SCAN_START_HOUR || hourET >= SCAN_STOP_HOUR) {
    return; // ⏸️ Outside scan window
  }

  for (const sport of SCAN_SPORTS) {
    try {
      if (!FETCHERS[sport]) continue; // skip unsupported

      let combined = [];

      if (sport === "mlb") {
        const f5 = await FETCHERS.mlb.f5_h2h({ minHold: null });
        const f5Totals = await FETCHERS.mlb.f5_totals({ minHold: null });
        const fullH2H = await FETCHERS.mlb.h2h({ minHold: null });
        const fullTotals = await FETCHERS.mlb.totals({ minHold: null });
        const spreads = await FETCHERS.mlb.spreads({ minHold: null });
        const teamTotals = await FETCHERS.mlb.team_totals({ minHold: null });

        combined = [...(f5 || []), ...(f5Totals || []), ...(fullH2H || []), ...(fullTotals || []), ...(spreads || []), ...(teamTotals || [])];
      } else {
        // Generic H2H / Spreads / Totals for other sports
        const h2h = await FETCHERS[sport].h2h?.({ minHold: null }) || [];
        const spreads = await FETCHERS[sport].spreads?.({ minHold: null }) || [];
        const totals = await FETCHERS[sport].totals?.({ minHold: null }) || [];

        combined = [...h2h, ...spreads, ...totals];
      }

      if (combined.length > 0) {
        const message = formatSharpBatch(combined);
        await sendTelegramMessage(message);
      }
    } catch (err) {
      console.error(`❌ Auto scan error for ${sport}:`, err);
    }
  }
}

// Kick off every 30 seconds
setInterval(runScans, 30 * 1000);

/* -------------------- Routes -------------------- */
app.get("/api/:sport/:market", oddsHandler);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
