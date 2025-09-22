import "dotenv/config";
import express from "express";
import cors from "cors";
import cron from "node-cron";
import { FETCHERS, isOn } from "./fetchers.js";

// Direct odds imports kept for existing routes and props handler
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
import { analyzeMarket } from "../sharpEngine.js";

const app = express();
app.use(cors());

/* -------------------- Utils -------------------- */
function nowET() {
  return new Date().toLocaleString("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/* -------------------- Safe market fetch (skips unsupported / throttled) -------------------- */
async function fetchMarketSafe(label, fn, args = {}) {
  try {
    const out = await fn(args);
    return Array.isArray(out) ? out : [];
  } catch (err) {
    const msg = String(err?.message || err);
    // Odds API common failures
    if (
      msg.includes("INVALID_MARKET") ||
      msg.includes("Markets not supported") ||
      msg.includes("status=422")
    ) {
      console.warn(`⚠️  Skipping unsupported market: ${label}`);
      return [];
    }
    if (msg.includes("429") || msg.toLowerCase().includes("too many requests")) {
      console.warn(`⏳ Rate-limited on market: ${label} (429) — skipping this cycle`);
      return [];
    }
    console.error(`❌ Fetch failed for ${label}:`, err);
    return [];
  }
}

/* -------------------- Health -------------------- */
app.get("/health", (_req, res) => res.json({ ok: true }));

/* -------------------- Telegram Alerts (current formatter retained) -------------------- */
async function handleScanAndAlerts(alerts, req = null, autoMode = false) {
  try {
    const shouldSend =
      autoMode || (req && String(req.query.telegram || "").toLowerCase() === "true");
    if (!shouldSend || !Array.isArray(alerts) || alerts.length === 0) return;

    // Use your existing formatter
    const formatted = formatSharpBatch(alerts);

    const timestamp = nowET();
    const header = `🔔 *GoSignals Batch Alert*  \n⏰ ${timestamp} ET  \nTotal: ${alerts.length}`;
    const batchMessage = [header, ...formatted].join("\n\n────────────\n\n");

    await sendTelegramMessage(batchMessage);
    console.log(`📨 Sent ${alerts.length} alerts in 1 Telegram message @ ${timestamp} ET.`);
  } catch (err) {
    console.error("❌ Error sending Telegram alerts:", err);
  }
}

/* --------------------------------------------------------------- */
/*                         EXISTING ROUTES                         */
/* --------------------------------------------------------------- */

/* -------------------- MLB F5 Scan (existing) -------------------- */
app.get("/api/mlb/f5_scan", async (req, res) => {
  try {
    let limit = 5;
    if (String(req.query.telegram || "").toLowerCase() === "true") limit = 15;
    if (req.query.limit !== undefined) {
      limit = Math.min(15, Math.max(1, Number(req.query.limit)));
    }

    const h2h = await fetchMarketSafe("MLB F5 H2H", getMLBF5H2HNormalized, { minHold: null });
    const totals = await fetchMarketSafe("MLB F5 Totals", getMLBF5TotalsNormalized, { minHold: null });

    const combined = [
      ...(Array.isArray(h2h) ? h2h.slice(0, limit) : []),
      ...(Array.isArray(totals) ? totals.slice(0, limit) : []),
    ];

    const analyzed = combined.map(a => analyzeMarket(a)).filter(a => a !== null);

    await handleScanAndAlerts(analyzed, req);
    res.json({ limit, f5_h2h: h2h, f5_totals: totals });
  } catch (err) {
    console.error("f5_scan error:", err);
    res.status(500).json({ error: String(err) });
  }
});

/* -------------------- MLB Full Game Scan (existing) -------------------- */
app.get("/api/mlb/game_scan", async (req, res) => {
  try {
    let limit = 5;
    if (String(req.query.telegram || "").toLowerCase() === "true") limit = 15;
    if (req.query.limit !== undefined) {
      limit = Math.min(15, Math.max(1, Number(req.query.limit)));
    }

    const h2h        = await fetchMarketSafe("MLB H2H", getMLBH2HNormalized, { minHold: null });
    const totals     = await fetchMarketSafe("MLB Totals", getMLBTotalsNormalized, { minHold: null });
    const spreads    = await fetchMarketSafe("MLB Spreads", getMLBSpreadsNormalized, { minHold: null });
    const teamTotals = await fetchMarketSafe("MLB Team Totals", getMLBTeamTotalsNormalized, { minHold: null });

    const combined = [
      ...(Array.isArray(h2h) ? h2h.slice(0, limit) : []),
      ...(Array.isArray(totals) ? totals.slice(0, limit) : []),
      ...(Array.isArray(spreads) ? spreads.slice(0, limit) : []),
      ...(Array.isArray(teamTotals) ? teamTotals.slice(0, limit) : []),
    ];

    const analyzed = combined.map(a => analyzeMarket(a)).filter(a => a !== null);

    await handleScanAndAlerts(analyzed, req);
    res.json({ limit, h2h, totals, spreads, teamTotals });
  } catch (err) {
    console.error("game_scan error:", err);
    res.status(500).json({ error: String(err) });
  }
});

/* -------------------- Generic Odds JSON (existing) -------------------- */
app.get("/api/:sport/:market", async (req, res) => {
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

    const data = await fetchMarketSafe(`${sport} ${market}`, FETCHERS[sport][market], { minHold: null });
    if (raw) return res.json(data);

    const analyzed = Array.isArray(data)
      ? data.map(a => analyzeMarket(a)).filter(a => a !== null)
      : [];

    res.json(analyzed);
  } catch (err) {
    console.error("oddsHandler error:", err);
    res.status(500).json({ error: String(err) });
  }
});

/* --------------------------------------------------------------- */
/*                 NEW: /api/scan/:sport (toggle-aware)           */
/* --------------------------------------------------------------- */

app.get("/api/scan/:sport", async (req, res) => {
  try {
    const sport = String(req.params.sport || "").toLowerCase();
    if (!FETCHERS[sport]) return res.status(400).json({ error: "unsupported_sport", sport });

    const limit = Math.min(15, Math.max(1, Number(req.query.limit ?? 15)));
    const wantsTelegram = String(req.query.telegram || "").toLowerCase() === "true";

    const batches = [];

    if (sport === "mlb") {
      if (isOn("ENABLE_MLB_H2H", true))
        batches.push(fetchMarketSafe("MLB H2H",        FETCHERS.mlb.h2h,        { minHold: null }));
      if (isOn("ENABLE_MLB_SPREADS", true))
        batches.push(fetchMarketSafe("MLB Spreads",    FETCHERS.mlb.spreads,    { minHold: null }));
      if (isOn("ENABLE_MLB_TOTALS", true))
        batches.push(fetchMarketSafe("MLB Totals",     FETCHERS.mlb.totals,     { minHold: null }));
      if (isOn("ENABLE_MLB_F5_H2H", true))
        batches.push(fetchMarketSafe("MLB F5 H2H",     FETCHERS.mlb.f5_h2h,     { minHold: null }));
      if (isOn("ENABLE_MLB_F5_TOTALS", true))
        batches.push(fetchMarketSafe("MLB F5 Totals",  FETCHERS.mlb.f5_totals,  { minHold: null }));
      if (isOn("ENABLE_MLB_TEAM_TOTALS", true))
        batches.push(fetchMarketSafe("MLB Team Totals", FETCHERS.mlb.team_totals, { minHold: null }));
      if (isOn("ENABLE_MLB_ALT", true))
        batches.push(fetchMarketSafe("MLB Alt",        FETCHERS.mlb.alt,        { minHold: null }));
    }

    if (sport === "nfl") {
      if (isOn("ENABLE_NFL_H2H", true))
        batches.push(fetchMarketSafe("NFL H2H",     FETCHERS.nfl.h2h,     { minHold: null }));
      if (isOn("ENABLE_NFL_SPREADS", true))
        batches.push(fetchMarketSafe("NFL Spreads", FETCHERS.nfl.spreads, { minHold: null }));
      if (isOn("ENABLE_NFL_TOTALS", true))
        batches.push(fetchMarketSafe("NFL Totals",  FETCHERS.nfl.totals,  { minHold: null }));

      // First Half (1H) — optional; only if functions exist
      if (isOn("ENABLE_NFL_H1", true)) {
        if (FETCHERS.nfl.h1_spreads)
          batches.push(fetchMarketSafe("NFL 1H Spreads", FETCHERS.nfl.h1_spreads, { minHold: null }));
        if (FETCHERS.nfl.h1_totals)
          batches.push(fetchMarketSafe("NFL 1H Totals",  FETCHERS.nfl.h1_totals,  { minHold: null }));
        if (FETCHERS.nfl.h1_h2h)
          batches.push(fetchMarketSafe("NFL 1H H2H",     FETCHERS.nfl.h1_h2h,     { minHold: null }));
      }
    }

    if (sport === "nba") {
      if (isOn("ENABLE_NBA_H2H", true))
        batches.push(fetchMarketSafe("NBA H2H",     FETCHERS.nba.h2h,     { minHold: null }));
      if (isOn("ENABLE_NBA_SPREADS", true))
        batches.push(fetchMarketSafe("NBA Spreads", FETCHERS.nba.spreads, { minHold: null }));
      if (isOn("ENABLE_NBA_TOTALS", true))
        batches.push(fetchMarketSafe("NBA Totals",  FETCHERS.nba.totals,  { minHold: null }));
    }

    if (sport === "ncaaf") {
      if (isOn("ENABLE_NCAAF_H2H", true))
        batches.push(fetchMarketSafe("NCAAF H2H",     FETCHERS.ncaaf.h2h,     { minHold: null }));
      if (isOn("ENABLE_NCAAF_SPREADS", true))
        batches.push(fetchMarketSafe("NCAAF Spreads", FETCHERS.ncaaf.spreads, { minHold: null }));
      if (isOn("ENABLE_NCAAF_TOTALS", true))
        batches.push(fetchMarketSafe("NCAAF Totals",  FETCHERS.ncaaf.totals,  { minHold: null }));
    }

    if (sport === "ncaab") {
      if (isOn("ENABLE_NCAAB_H2H", true))
        batches.push(fetchMarketSafe("NCAAB H2H",     FETCHERS.ncaab.h2h,     { minHold: null }));
      if (isOn("ENABLE_NCAAB_SPREADS", true))
        batches.push(fetchMarketSafe("NCAAB Spreads", FETCHERS.ncaab.spreads, { minHold: null }));
      if (isOn("ENABLE_NCAAB_TOTALS", true))
        batches.push(fetchMarketSafe("NCAAB Totals",  FETCHERS.ncaab.totals,  { minHold: null }));
    }

    const settled = await Promise.all(batches);
    const flattened = settled.flat();
    const limited = flattened.slice(0, limit);

    const analyzed = limited.map(a => analyzeMarket(a)).filter(a => a !== null);

    // Send to Telegram if requested
    await handleScanAndAlerts(analyzed, wantsTelegram ? req : null, wantsTelegram);

    res.json({
      sport,
      limit,
      pulled: flattened.length,
      analyzed: analyzed.length,
      sent_to_telegram: wantsTelegram ? analyzed.length : 0,
      timestamp_et: nowET(),
    });
  } catch (err) {
    console.error("scan route error:", err);
    res.status(500).json({ error: String(err) });
  }
});

/* --------------------------------------------------------------- */
/*                         AUTO SCANNING                          */
/* --------------------------------------------------------------- */

cron.schedule("*/3 * * * *", async () => {
  const hourET = new Date().toLocaleString("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    hour12: false
  });
  const hour = Number(hourET);

  if (hour < Number(process.env.SCAN_START_HOUR || 6) ||
      hour >= Number(process.env.SCAN_STOP_HOUR || 24)) return;

  const sports = (process.env.SCAN_SPORTS || "mlb").split(",").map(s => s.trim().toLowerCase());
  for (const sport of sports) {
    try {
      // Use your canonical app URL
      const url = `https://odds-backend-oo4k.onrender.com/api/scan/${sport}?telegram=true&limit=15`;
      const res = await fetch(url);
      const data = await res.json();
      console.log(`🤖 Auto-scan ${sport}: pulled=${data.pulled} analyzed=${data.analyzed} @ ${data.timestamp_et} ET`);
    } catch (err) {
      console.error(`❌ Auto-scan failed for ${sport}:`, err);
    }
  }
});

/* -------------------- Start Server -------------------- */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
