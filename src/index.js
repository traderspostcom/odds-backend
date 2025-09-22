import "dotenv/config";
import express from "express";
import cors from "cors";
import cron from "node-cron";
import { FETCHERS, isOn } from "./fetchers.js";

/* -------------------- Rate-limit helpers -------------------- */
const RATE_LIMIT_MS = Number(process.env.RATE_LIMIT_MS || 350);     // delay between requests
const RETRY_429_MAX = Number(process.env.RETRY_429_MAX || 3);       // max retries on 429
const RETRY_BASE_MS = Number(process.env.RETRY_BASE_MS || 400);     // backoff base

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function fetchWithRetry(label, fn, args = {}) {
  let attempt = 0;
  // small jitter so parallel deploys don’t sync their spikes
  const jitter = () => Math.floor(Math.random() * 120);

  while (true) {
    try {
      const out = await fn(args);
      return Array.isArray(out) ? out : [];
    } catch (err) {
      const msg = String(err?.message || err);

      // Unsupported / 422 → skip quietly
      if (
        msg.includes("INVALID_MARKET") ||
        msg.includes("Markets not supported") ||
        msg.includes("status=422")
      ) {
        console.warn(`⚠️  Skipping unsupported market: ${label}`);
        return [];
      }

      // 429 backoff & retry
      if (msg.includes("429") || msg.toLowerCase().includes("too many requests")) {
        if (attempt >= RETRY_429_MAX) {
          console.warn(`⏳ 429 on ${label} — max retries hit, skipping`);
          return [];
        }
        const wait = RETRY_BASE_MS * Math.pow(2, attempt) + jitter();
        console.warn(`⏳ 429 on ${label} — retrying in ${wait}ms (attempt ${attempt + 1}/${RETRY_429_MAX})`);
        await sleep(wait);
        attempt++;
        continue;
      }

      // Other errors → log and skip
      console.error(`❌ Fetch failed for ${label}:`, err);
      return [];
    }
  }
}

/** Run fetch jobs one-by-one with a fixed pacing delay to avoid bursts. */
async function runSequential(labelledJobs) {
  const results = [];
  for (const job of labelledJobs) {
    const [label, fn, args] = job;
    const data = await fetchWithRetry(label, fn, args);
    results.push(data);
    await sleep(RATE_LIMIT_MS);
  }
  return results.flat();
}


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

import { sendTelegramMessage } from "../telegram.js";
import { analyzeMarket } from "../sharpEngine.js";
import { formatSharpBatchV2 } from "../sharpFormatter.js";

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

/* -------------------- V2 card adapter -------------------- */
function mapMarketType(mkt) {
  if (!mkt) return "H2H";
  const s = String(mkt).toLowerCase();
  if (s.includes("spread")) return "Spread";
  if (s.includes("team") && s.includes("total")) return "Team Total";
  if (s.includes("total") && s.includes("f5")) return "F5 Total";
  if (s.includes("h2h")   && s.includes("f5")) return "F5 H2H";
  if (s.includes("total")) return "Total";
  return "H2H";
}
function toCardShape(a) {
  if (!a) return null;
  const marketType = mapMarketType(a.market);
  const tier = (a?.render?.strength || "").toLowerCase().includes("strong") ? "strong" : "lean";
  let alertKind = "initial";
  if (a?.type === "realert") alertKind = "reentry";
  if (a?.type === "realert_plus") alertKind = "improved";

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
      atOrBetter: true,
      fairPrice: undefined,
      consensusPrice: a?.lines?.current_consensus ?? null
    },
    lineMove: {
      open: undefined,
      current: a?.lines?.current_consensus ?? null,
      delta: undefined
    },
    consensus: a?.consensus ? {
      ticketsPct: a.consensus.ticketsPct,
      handlePct:  a.consensus.handlePct,
      gapPct:     a.consensus.gapPct
    } : undefined,
    holdPct: a?.holdPct ?? undefined,
    score: { total: Number(a?.score ?? 0), tier },
    signals: Array.isArray(a?.signals) ? a.signals : [],
    keyNumber: a?.keyNumber || { note: null },
    books: Array.isArray(a?.books) ? a.books : [],
    alertKind,
    cooldownMins: undefined,
    profile: a?.meta?.profile || process.env.SHARP_PROFILE || "sharpest"
  };
}

/* -------------------- Health -------------------- */
app.get("/health", (_req, res) => res.json({ ok: true }));

/* -------------------- Telegram Alerts (MAX-INFO) -------------------- */
async function handleScanAndAlerts(analyzed, req = null, autoMode = false) {
  try {
    const shouldSend =
      autoMode || (req && String(req.query.telegram || "").toLowerCase() === "true");
    if (!shouldSend || !Array.isArray(analyzed) || analyzed.length === 0) return;

    const cards = analyzed.map(toCardShape).filter(Boolean);
    const credits = process.env.CREDITS_MONTHLY_LIMIT
      ? { used: Number(process.env.CREDITS_USED || 0), limit: Number(process.env.CREDITS_MONTHLY_LIMIT) }
      : null;

    const text = formatSharpBatchV2(cards, {
      mode: (process.env.SHARP_PROFILE || "sharpest").toUpperCase(),
      auto: Boolean(autoMode),
      credits,
      now: new Date()
    });

    await sendTelegramMessage(text);
    console.log(`📨 Sent ${cards.length} alerts @ ${nowET()} ET`);
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

    const h2h    = await fetchMarketSafe("MLB F5 H2H",    getMLBF5H2HNormalized,   { minHold: null });
    const totals = await fetchMarketSafe("MLB F5 Totals", getMLBF5TotalsNormalized,{ minHold: null });

    const combined = [
      ...(Array.isArray(h2h) ? h2h.slice(0, limit) : []),
      ...(Array.isArray(totals) ? totals.slice(0, limit) : []),
    ];

    const analyzed = combined.map(a => analyzeMarket(a)).filter(Boolean);

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

    const h2h        = await fetchMarketSafe("MLB H2H",         getMLBH2HNormalized,       { minHold: null });
    const totals     = await fetchMarketSafe("MLB Totals",      getMLBTotalsNormalized,    { minHold: null });
    const spreads    = await fetchMarketSafe("MLB Spreads",     getMLBSpreadsNormalized,   { minHold: null });
    const teamTotals = await fetchMarketSafe("MLB Team Totals", getMLBTeamTotalsNormalized,{ minHold: null });

    const combined = [
      ...(Array.isArray(h2h) ? h2h.slice(0, limit) : []),
      ...(Array.isArray(totals) ? totals.slice(0, limit) : []),
      ...(Array.isArray(spreads) ? spreads.slice(0, limit) : []),
      ...(Array.isArray(teamTotals) ? teamTotals.slice(0, limit) : []),
    ];

    const analyzed = combined.map(a => analyzeMarket(a)).filter(Boolean);

    await handleScanAndAlerts(analyzed, req);
    res.json({ limit, h2h, totals, spreads, teamTotals });
  } catch (err) {
    console.error("game_scan error:", err);
    res.status(500).json({ error: String(err) });
  }
});

/* --------------------------------------------------------------- */
/*           NEW: /api/scan/:sport (PLACE THIS BEFORE GENERIC)    */
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
/*                GENERIC /api/:sport/:market (AFTER scan)        */
/* --------------------------------------------------------------- */

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

    // return normalized cards for debugging
    const cards = analyzed.map(toCardShape).filter(Boolean);
    res.json(cards);
  } catch (err) {
    console.error("oddsHandler error:", err);
    res.status(500).json({ error: String(err) });
  }
});

/* --------------------------------------------------------------- */
/* -------------------- Auto Scanning (hardened) -------------------- */
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
    const url = `https://odds-backend-oo4k.onrender.com/api/scan/${sport}?telegram=true&limit=15`;
    try {
      const res = await fetch(url);
      const ct = (res.headers.get("content-type") || "").toLowerCase();

      if (!res.ok) {
        const body = await res.text(); // may be HTML
        console.warn(`🤖 Auto-scan ${sport}: HTTP ${res.status} (${res.statusText})`);
        // optional: log a short preview of non-JSON
        console.warn(body.slice(0, 160));
        // brief pause between sports to be polite
        await new Promise(r => setTimeout(r, Number(process.env.CRON_PAUSE_BETWEEN_SPORTS_MS || 800)));
        continue;
      }

      if (!ct.includes("application/json")) {
        const body = await res.text();
        console.warn(`🤖 Auto-scan ${sport}: Non-JSON response (content-type=${ct || "unknown"})`);
        console.warn(body.slice(0, 160));
        await new Promise(r => setTimeout(r, Number(process.env.CRON_PAUSE_BETWEEN_SPORTS_MS || 800)));
        continue;
      }

      const data = await res.json();
      console.log(`🤖 Auto-scan ${sport}: pulled=${data.pulled} analyzed=${data.analyzed} @ ${data.timestamp_et} ET`);
    } catch (err) {
      console.error(`❌ Auto-scan failed for ${sport}:`, err);
    }

    // brief pause between sports
    await new Promise(r => setTimeout(r, Number(process.env.CRON_PAUSE_BETWEEN_SPORTS_MS || 800)));
  }
});

/* -------------------- Start Server -------------------- */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
