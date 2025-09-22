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

import { sendTelegramMessage } from "../telegram.js";
import { analyzeMarket } from "../sharpEngine.js";
import { formatSharpBatchV2 } from "../sharpFormatter.js";

const app = express();
app.use(cors());

/* -------------------- Health -------------------- */
app.get("/health", (_req, res) => res.json({ ok: true }));

/* -------------------- Fetchers per sport -------------------- */
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

/* -------------------- Formatter adapter -------------------- */
/** Map your current analyzeMarket() payload into the V2 card shape.
 *  This lets us upgrade Telegram formatting WITHOUT touching sharpEngine yet.
 *  Missing fields gracefully render as “—”.
 */
function toCardShape(a) {
  if (!a) return null;

  // market mapping (best-effort)
  const marketType = mapMarketType(a.market);

  // badge tier from your render.strength or basic score
  const tier = (a?.render?.strength || "").toLowerCase().includes("strong")
    ? "strong"
    : "lean";

  // alert kind mapping
  let alertKind = "initial";
  if (a?.type === "realert") alertKind = "reentry";
  if (a?.type === "realert_plus") alertKind = "improved";

  // build normalized card object
  return {
    id: a.game_id || a.id || `${a?.game?.away}-${a?.game?.home}-${marketType}`,

    sport: (a.sport || "").toUpperCase(),
    league: a.league || a.sport || "",
    marketType,
    matchup: a.game ? `${a.game.away} @ ${a.game.home}` : undefined,
    game: {
      home: a?.game?.home,
      away: a?.game?.away,
      start_time_utc: a?.game?.start_time_utc || null
    },

    side: {
      team: a?.sharp_side?.team || null,
      entryPrice: a?.lines?.sharp_entry ?? null,
      atOrBetter: true,                            // default for now
      fairPrice: undefined,                        // add later in sharpEngine (optional)
      consensusPrice: a?.lines?.current_consensus ?? null
    },

    lineMove: {
      open: undefined,                             // add later if available
      current: a?.lines?.current_consensus ?? null,
      delta: undefined
    },

    consensus: a?.consensus ? {
      ticketsPct: a.consensus.ticketsPct,
      handlePct:  a.consensus.handlePct,
      gapPct:     a.consensus.gapPct
    } : undefined,                                  // we’ll fill this in Step 2

    holdPct: a?.holdPct ?? undefined,              // we’ll fill this in Step 2

    score: { total: Number(a?.score ?? 0), tier },

    signals: Array.isArray(a?.signals) ? a.signals : [], // we’ll add structured signals in Step 2
    keyNumber: a?.keyNumber || { note: null },

    books: Array.isArray(a?.books) ? a.books : [], // optional list of { book, price }

    alertKind,
    cooldownMins: undefined,
    profile: a?.meta?.profile || process.env.SHARP_PROFILE || "sharpest"
  };
}

function mapMarketType(mkt) {
  if (!mkt) return "H2H";
  const s = String(mkt).toLowerCase();
  if (s.includes("spread")) return "Spread";
  if (s.includes("total") && s.includes("team")) return "Team Total";
  if (s.includes("total")) return "Total";
  if (s.includes("f5") && s.includes("h2h")) return "F5 H2H";
  if (s.includes("f5") && s.includes("total")) return "F5 Total";
  return "H2H";
}

/* -------------------- Telegram Alerts -------------------- */
async function handleScanAndAlerts(alerts, req = null, autoMode = false) {
  try {
    const shouldSend =
      autoMode || (req && String(req.query.telegram || "").toLowerCase() === "true");
    if (!shouldSend || !Array.isArray(alerts) || alerts.length === 0) return;

    // Normalize alerts for V2 card format
    const cards = alerts.map(toCardShape).filter(Boolean);

    // Credits (optional)
    const credits = process.env.CREDITS_MONTHLY_LIMIT
      ? {
          used: Number(process.env.CREDITS_USED || 0),
          limit: Number(process.env.CREDITS_MONTHLY_LIMIT)
        }
      : null;

    const formatted = formatSharpBatchV2(cards, {
      mode: (process.env.SHARP_PROFILE || "sharpest").toUpperCase(),
      auto: Boolean(autoMode),
      credits,
      now: new Date()
    });

    await sendTelegramMessage(formatted);
  } catch (err) {
    console.error("❌ Error sending Telegram alerts:", err);
  }
}

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

    const combined = [
      ...(Array.isArray(h2h) ? h2h.slice(0, limit) : []),
      ...(Array.isArray(totals) ? totals.slice(0, limit) : [])
    ];

    // 🔎 Run through sharp engine (kept as-is)
    const analyzed = combined.map(a => analyzeMarket(a)).filter(a => a !== null);

    await handleScanAndAlerts(analyzed, req);
    res.json({ limit, f5_h2h: h2h, f5_totals: totals });
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

    const combined = [
      ...(Array.isArray(h2h) ? h2h.slice(0, limit) : []),
      ...(Array.isArray(totals) ? totals.slice(0, limit) : []),
      ...(Array.isArray(spreads) ? spreads.slice(0, limit) : []),
      ...(Array.isArray(teamTotals) ? teamTotals.slice(0, limit) : [])
    ];

    const analyzed = combined.map(a => analyzeMarket(a)).filter(a => a !== null);

    await handleScanAndAlerts(analyzed, req);
    res.json({ limit, h2h, totals, spreads, teamTotals });
  } catch (err) {
    console.error("game_scan error:", err);
    res.status(500).json({ error: String(err) });
  }
});

/* -------------------- Generic Odds Handler -------------------- */
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

    const analyzed = Array.isArray(data)
      ? data.map(a => analyzeMarket(a)).filter(a => a !== null)
      : [];

    // Return normalized cards when hitting the JSON API (handy for debugging)
    const cards = analyzed.map(toCardShape).filter(Boolean);
    res.json(cards);
  } catch (err) {
    console.error("oddsHandler error:", err);
    res.status(500).json({ error: String(err) });
  }
}
app.get("/api/:sport/:market", oddsHandler);

/* -------------------- Auto Scanning (kept same cadence) -------------------- */
cron.schedule("*/3 * * * *", async () => {
  const hourET = new Date().toLocaleString("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    hour12: false
  });
  const hour = Number(hourET);

  if (hour < process.env.SCAN_START_HOUR || hour >= process.env.SCAN_STOP_HOUR) return;

  const sports = (process.env.SCAN_SPORTS || "mlb").split(",").map(s => s.trim().toLowerCase());
  for (const sport of sports) {
    try {
      // NOTE: MLB has the f5_scan route; other sports may 404 — that’s fine for now.
      const url = `https://odds-backend-oo4k.onrender.com/api/${sport}/f5_scan?telegram=true`;
      const res = await fetch(url);
      const data = await res.json();

      const betCount = Array.isArray(data) ? data.length : 0;
      if (betCount > 0) {
        console.log(`✅ Auto-scan ran for ${sport}, found ${betCount} bets`);
      }
    } catch (err) {
      console.error(`❌ Auto-scan failed for ${sport}:`, err);
    }
  }
});

/* -------------------- Start Server -------------------- */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
