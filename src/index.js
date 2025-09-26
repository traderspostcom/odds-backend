// src/index.js (ESM) — Odds Backend on Render
import express from "express";
import cors from "cors";
import fetch from "node-fetch";

import {
  getNFLH2HNormalized,
  getMLBH2HNormalized,
  getNCAAFH2HNormalized,
  diagListBooksForSport
} from "./fetchers.js";

import { analyzeMarket } from "../sharpEngine.js";

const app = express();
app.use(cors());
app.use(express.json({ limit: "256kb" }));
const PORT = process.env.PORT || 10000;

/* ------------------------------- helpers -------------------------------- */
function BOOL(v, def = false) {
  if (v == null) return def;
  const s = String(v).trim().toLowerCase();
  if (["1", "true", "yes", "y"].includes(s)) return true;
  if (["0", "false", "no", "n"].includes(s)) return false;
  return def;
}
function nowET(d = new Date()) {
  return d.toLocaleString("en-US", { timeZone: "America/New_York" });
}
function safeJson(s) { try { return JSON.parse(s); } catch { return String(s); } }

/* --------------------------- season windows --------------------------- */
// Guards scans when a sport is out-of-season, with optional padding.
function isSeasonActive(sport, now = new Date()) {
  const padBefore = Number(process.env.SEASON_PAD_BEFORE_DAYS || 0);
  const padAfter  = Number(process.env.SEASON_PAD_AFTER_DAYS  || 7);

  const SEASONS = {
    mlb:   { start: { m: 2, d: 20, yOff: 0 }, end: { m: 9, d: 31, yOff: 0 } },  // ~Mar 20 – Oct 31
    nfl:   { start: { m: 8, d:  1, yOff: 0 }, end: { m: 1, d: 15, yOff: 1 } },  // ~Sep 1  – Feb 15 (next yr)
    ncaaf: { start: { m: 7, d: 20, yOff: 0 }, end: { m: 0, d: 15, yOff: 1 } }   // ~Aug 20 – Jan 15 (next yr)
  };

  const cfg = SEASONS[String(sport).toLowerCase()];
  if (!cfg) return true;

  const y = now.getUTCFullYear();
  const ms = 24 * 60 * 60 * 1000;

  const startUTC = Date.UTC(y + (cfg.start.yOff || 0), cfg.start.m, cfg.start.d);
  const endUTC   = Date.UTC(y + (cfg.end.yOff   || 0), cfg.end.m,   cfg.end.d, 23, 59, 59, 999);

  const startWithPad = startUTC - padBefore * ms;
  const endWithPad   = endUTC   + padAfter  * ms;

  if ((cfg.end.yOff || 0) > (cfg.start.yOff || 0) || cfg.end.m < cfg.start.m) {
    const thisYearStart = startWithPad;
    const thisYearEnd   = Date.UTC(y, 11, 31, 23, 59, 59, 999);
    const nextYearStart = Date.UTC(y + (cfg.end.yOff || 0), 0, 1);
    const nextYearEnd   = endWithPad;
    const t = now.getTime();
    return (t >= thisYearStart && t <= thisYearEnd) || (t >= nextYearStart && t <= nextYearEnd);
  }
  return now.getTime() >= startWithPad && now.getTime() <= endWithPad;
}

/* ------------------------------- guards -------------------------------- */
function guard(fn) {
  return async (req, res) => {
    try { await fn(req, res); }
    catch (err) {
      console.error("handler_error", {
        path: req.path,
        msg: String((err && err.message) || err),
        stack: err && err.stack
      });
      res.status(500).json({ ok: false, error: "internal_error" });
    }
  };
}

// scan key gate (optional via env: SCAN_KEY)
function gateScan(req, res, next) {
  const required = process.env.SCAN_KEY;
  if (!required) return next();
  const provided = req.get("x-scan-key") || req.query.scan_key || "";
  if (provided !== required) return res.status(401).json({ ok: false, error: "scan_key_required" });
  next();
}

/* -------------------------------- TG ------------------------------------ */
async function sendTelegram(text, { force = false } = {}) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  const auto = BOOL(process.env.AUTO_TELEGRAM, false);

  if (!token || !chatId) return { ok: false, error: "telegram_not_configured" };
  if (!auto && !force)   return { ok: false, skipped: true, reason: "AUTO_TELEGRAM=false and force!=1" };

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const body = { chat_id: chatId, text, parse_mode: "Markdown", disable_web_page_preview: true };

  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok && j.ok, status: r.status, body: j };
}

// Map backend market to label
function mapMarketLabel(market) {
  const norm = String(market || "").toLowerCase().replace(/[_\-\s]/g, "");
  if (norm.includes("1st5") || norm.includes("first5") || norm.includes("f5")) return "F5";
  if (norm.includes("h2h") || norm === "") return "ML";
  if (norm.includes("spreads")) return "SP";
  if (norm.includes("totals"))  return "TOT";
  return (market || "").toUpperCase();
}

// Format a single alert into a message
function formatAlertForTelegram(a) {
  const siren = "🚨";       // leading icon
  const evIcon = "📈";      // EV icon
  const strength = a?.render?.strength || ""; // e.g., 🟡 Lean / 🟢 Strong

  // Date/time in ET
  let gameTimeEt = "TBD";
  const gt = a?.game?.start_time_utc || a?.commence_time || null;
  if (gt) {
    try {
      const dt = new Date(gt);
      gameTimeEt = dt.toLocaleString("en-US", {
        timeZone: "America/New_York",
        month: "short", day: "numeric",
        hour: "numeric", minute: "2-digit"
      });
    } catch {}
  }

  // EV, Edge, Kelly if present in signals
  const sigs = Array.isArray(a?.signals) ? a.signals : [];
  const evSig     = sigs.find(s => /ev_pct/i.test(s.key || ""));
  const edgeSig   = sigs.find(s => /edge_pct/i.test(s.key || ""));
  const kellySig  = sigs.find(s => /kelly/i.test(s.key || ""));
  const evText    = evSig ? evSig.label.replace(/\s+/g, " ") : null;
  const edgeText  = edgeSig ? edgeSig.label.replace(/\s+/g, " ") : null;
  const kellyText = kellySig ? kellySig.label.replace(/\s+/g, " ") : null;

  // Line + book
  const entry = a?.lines?.sharp_entry;
  const entryText = entry != null ? (entry >= 0 ? `+${entry}` : `${entry}`) : "-";
  const book = a?.lines?.book || "-";

  const title = `*${siren} GoSignals Alert*`;
  const market = `${(a?.sport || "").toUpperCase()} ${mapMarketLabel(a?.market)}`;
  const matchup = `${a?.game?.away || a?.away || "Away"} @ ${a?.game?.home || a?.home || "Home"}`;

  const parts = [
    `${title}\n`,
    `*${market}*  ${strength}`,
    `🕒 ${gameTimeEt}`,
    `${matchup}`,   // removed ⚔️ here
    `🎯 Pick: *${a?.sharp_side?.team || "-"}* (${a?.sharp_side?.side || "-"}) @ ${entryText} on *${book}*`,
  ];

  const extras = [];
  if (evText)   extras.push(`${evIcon} ${evText}`);
  if (edgeText) extras.push(`📊 ${edgeText}`);
  if (kellyText) extras.push(`💵 ${kellyText}`);
  if (extras.length) parts.push("", ...extras);

  return parts.join("\n\n").trim();
}



/* -------------------------------- routes -------------------------------- */

// Health
app.get("/health", guard(async (_req, res) => {
  const env = {
    HARD_KILL: BOOL(process.env.HARD_KILL, false),
    SCAN_ENABLED: BOOL(process.env.SCAN_ENABLED, true),
    AUTO_TELEGRAM: BOOL(process.env.AUTO_TELEGRAM, false),
    DIAG: BOOL(process.env.DIAG, true),

    MANUAL_MAX_JOBS: Number(process.env.MANUAL_MAX_JOBS || 1),
    MAX_JOBS_PER_SPORT: Number(process.env.MAX_JOBS_PER_SPORT || 1),
    MAX_EVENTS_PER_CALL: Number(process.env.MAX_EVENTS_PER_CALL || 50),

    ENABLE_NFL_H2H: BOOL(process.env.ENABLE_NFL_H2H, true),
    ENABLE_NFL_H1:  BOOL(process.env.ENABLE_NFL_H1, true),
    ENABLE_MLB_H2H: BOOL(process.env.ENABLE_MLB_H2H, true),
    ENABLE_MLB_F5_H2H: BOOL(process.env.ENABLE_MLB_F5_H2H, true),
    ENABLE_NCAAF_H2H: BOOL(process.env.ENABLE_NCAAF_H2H, true),
    ENABLE_NCAAF_SPREADS: BOOL(process.env.ENABLE_NCAAF_SPREADS, false),
    ENABLE_NCAAF_TOTALS: BOOL(process.env.ENABLE_NCAAF_TOTALS, false),

    // mirror user-controlled odds settings
    ODDS_API_ENABLED: BOOL(process.env.ODDS_API_ENABLED, true),
    ODDS_API_KEY_present: !!process.env.ODDS_API_KEY,
    ODDS_API_REGION: process.env.ODDS_API_REGION || "",
    BOOKS_WHITELIST: process.env.BOOKS_WHITELIST || "",
    ALERT_BOOKS: process.env.ALERT_BOOKS || "",

    LEAN_THRESHOLD: Number(process.env.LEAN_THRESHOLD || 0.003),
    STRONG_THRESHOLD: Number(process.env.STRONG_THRESHOLD || 0.012),
    OUTLIER_DOG_CENTS_LEAN: Number(process.env.OUTLIER_DOG_CENTS_LEAN || 5),
    OUTLIER_DOG_CENTS_STRONG: Number(process.env.OUTLIER_DOG_CENTS_STRONG || 10),
    OUTLIER_FAV_CENTS_LEAN: Number(process.env.OUTLIER_FAV_CENTS_LEAN || 4),
    OUTLIER_FAV_CENTS_STRONG: Number(process.env.OUTLIER_FAV_CENTS_STRONG || 8),

    RETRY_429_MAX: Number(process.env.RETRY_429_MAX || 0),
    RATE_LIMIT_MS: Number(process.env.RATE_LIMIT_MS || 1200),
    CACHE_TTL_SECONDS: Number(process.env.CACHE_TTL_SECONDS || 60),

    TELEGRAM_CHAT_ID: String(process.env.TELEGRAM_CHAT_ID || ""),
    SCAN_KEY_present: !!process.env.SCAN_KEY,

    // season guards (Render-controlled)
    SEASON_GUARDS: BOOL(process.env.SEASON_GUARDS, true),
    SEASON_PAD_BEFORE_DAYS: Number(process.env.SEASON_PAD_BEFORE_DAYS || 0),
    SEASON_PAD_AFTER_DAYS: Number(process.env.SEASON_PAD_AFTER_DAYS || 7),
  };

  res.json({ ok: true, env, ts: new Date().toISOString() });
}));

// Provider sanity (cheap)
app.get("/diag/provider", guard(async (_req, res) => {
  const enabled = BOOL(process.env.ODDS_API_ENABLED, true);
  const key = process.env.ODDS_API_KEY;
  if (!enabled) return res.json({ ok: true, enabled, note: "provider disabled" });
  if (!key)     return res.status(400).json({ ok: false, error: "no_api_key" });

  const url = `https://api.the-odds-api.com/v4/sports/?apiKey=${encodeURIComponent(key)}`;
  const r = await fetch(url);
  const txt = await r.text();
  res.json({ ok: r.ok, status: r.status, body: safeJson(txt) });
}));

// Books per game (diagnostic) — gated
app.get("/api/diag/scan/:sport", gateScan, guard(async (req, res) => {
  const sport = String(req.params.sport || "").toLowerCase();
  const limit = Number(req.query.limit || 3);
  const raw = await diagListBooksForSport(sport, { limit });
  if (!Array.isArray(raw)) return res.status(400).json({ ok: false, error: "unsupported_sport" });
  res.json({
    ok: true, sport, limit,
    pulled: raw.length,
    events: raw.map(g => ({
      gameId: g.id,
      away: g.away,
      home: g.home,
      commence_time: g.commence_time,
      offers_count: Array.isArray(g.books) ? g.books.length : 0,
      books: g.books || []
    }))
  });
}));

// Telegram test
app.get("/api/telegram/test", guard(async (req, res) => {
  const force = req.query.force === "1";
  const text = req.query.text || "Hello from Odds Backend";
  const r = await sendTelegram(String(text), { force });
  res.json(r);
}));

// Synthetic alert (zero provider credits)
app.get("/api/scan/mock", guard(async (req, res) => {
  const telegram = req.query.telegram === "true";
  const force = req.query.force === "1";
  const bypass = req.query.bypass === "1";

  const alert = {
    type: bypass ? "forced" : "initial",
    source: "ev",
    sport: "nfl",
    market: "NFL ML",
    game_id: `mock-${Date.now()}`,
    game: {
      away: "Testers",
      home: "Mockers",
      start_time_utc: new Date(Date.now() + 60 * 60 * 1000).toISOString()
    },
    sharp_side: { side: "home", team: "Mockers", confidence: "strong" },
    lines: { sharp_entry: -105, current_consensus: -105, direction: "flat", book: "draftkings" },
    score: 3,
    signals: [
      { key: "ev_pct", label: "+3.00% EV", weight: 2 },
      { key: "kelly",  label: "Kelly 0.8% / ½ 0.4%", weight: 1 }
    ],
    render: {
      title: "SHARP ALERT – NFL Testers @ Mockers",
      emoji: "🚨",
      strength: "🟢 Strong",
      tags: ["EV"]
    },
    meta: { generated_at: new Date().toISOString() }
  };

  let sent = 0;
  if (telegram) {
    const text = formatAlertForTelegram(alert);
    const r = await sendTelegram(text, { force });
    sent = r.ok ? 1 : 0;
  }

  res.json({
    sport: "nfl",
    limit: 1,
    pulled: 1,
    analyzed: 1,
    sent_to_telegram: sent,
    timestamp_et: nowET(),
    planned_jobs: ["NFL ML (mock)"],
    alerts: [alert]
  });
}));

// Main scan — gated
app.get("/api/scan/:sport", gateScan, guard(async (req, res) => {
  const origin = req.get("x-scan-origin") || req.query.from || "unknown";
  const ua     = req.get("user-agent") || "-";
  const ip     = req.get("cf-connecting-ip") || req.get("x-forwarded-for") || req.ip || "-";
  const sport  = String(req.params.sport || "").toLowerCase();

  const sendQueryFlag = req.query.telegram === "true"; // manual override
  const autoTelegram  = BOOL(process.env.AUTO_TELEGRAM, false);
  const telegram      = sendQueryFlag || autoTelegram;

  const seasonGuardsOn = BOOL(process.env.SEASON_GUARDS, true);
  const seasonOverride = req.query.seasonOverride === "1";

  const oddsOn = String(process.env.ODDS_API_ENABLED || "true").toLowerCase();

  console.log(
    `[scan] sport=${sport} send=${telegram} origin=${origin} ip=${ip} ua="${ua}" odds_api_enabled=${oddsOn} qs=${JSON.stringify(req.query)}`
  );

  if (seasonGuardsOn && !seasonOverride && !isSeasonActive(sport)) {
    return res.json({
      sport,
      limit: 0,
      pulled: 0,
      analyzed: 0,
      sent_to_telegram: 0,
      timestamp_et: nowET(),
      planned_jobs: [],
      alerts: [],
      note: `season_inactive(${sport}) — guarded by SEASON_GUARDS with padding`
    });
  }

  const limit  = Number(req.query.limit  || process.env.MAX_EVENTS_PER_CALL || 50);
  const offset = Number(req.query.offset || 0);
  const force  = req.query.force  === "1";
  const bypass = req.query.bypass === "1";

  const plannedJobs = [];
  const jobs = [];

  if (sport === "nfl") {
    if (BOOL(process.env.ENABLE_NFL_H2H, true)) { plannedJobs.push("NFL ML"); jobs.push(getNFLH2HNormalized); }
  } else if (sport === "mlb") {
    if (BOOL(process.env.ENABLE_MLB_H2H, true)) { plannedJobs.push("MLB ML"); jobs.push(getMLBH2HNormalized); }
    if (BOOL(process.env.ENABLE_MLB_F5_H2H, true)) { plannedJobs.push("MLB F5"); /* add F5 fetcher when available */ }
  } else if (sport === "ncaaf") {
    if (BOOL(process.env.ENABLE_NCAAF_H2H, true)) { plannedJobs.push("NCAAF ML"); jobs.push(getNCAAFH2HNormalized); }
  } else {
    return res.status(400).json({ error: "unsupported_sport", sport });
  }

  if (!jobs.length) {
    return res.json({
      sport, limit, pulled: 0, analyzed: 0, sent_to_telegram: 0,
      timestamp_et: nowET(), planned_jobs: plannedJobs, alerts: [],
      note: "No jobs enabled via env for this sport."
    });
  }

  const snapshots = [];
  for (const job of jobs) {
    const take = Math.max(0, (offset || 0) + (limit || 0));
    const got = await job({ limit: take || limit || 1 });
    if (Array.isArray(got) && got.length) {
      const sliced = offset > 0 ? got.slice(offset, offset + limit) : got.slice(0, limit);
      snapshots.push(...sliced);
    }
  }

  const pulled = snapshots.length;
  const alerts = [];
  let analyzed = 0;
  let sent_to_telegram = 0;

  for (const snap of snapshots) {
    const normalized = {
      id: snap.id || snap.gameId || undefined,
      gameId: snap.id || snap.gameId || undefined,
      sport: snap.sport || sport,
      market: snap.market || (sport.toUpperCase() + " ML"),
      home: snap?.game?.home || snap.home,
      away: snap?.game?.away || snap.away,
      commence_time: snap?.game?.start_time_utc || snap.start_time_utc || snap.commence_time || null,
      game: snap.game || { away: snap.away, home: snap.home, start_time_utc: snap.commence_time },
      offers: snap.offers || [],
      source_meta: snap.source_meta || {}
    };

    const a = analyzeMarket(normalized, { bypassDedupe: bypass });
    if (a) { analyzed += 1; alerts.push(a); }
  }

  if (telegram && alerts.length) {
    for (const a of alerts) {
      const text = formatAlertForTelegram(a);
      const r = await sendTelegram(text, { force });
      if (r.ok) sent_to_telegram += 1;
    }
  }

  res.json({
    sport, limit, pulled, analyzed, sent_to_telegram,
    timestamp_et: nowET(), planned_jobs: plannedJobs, alerts
  });
}));

app.get("/", (_req, res) => res.json({ ok: true, name: "odds-backend", ts: new Date().toISOString() }));

app.listen(PORT, () => { console.log(`odds-backend listening on :${PORT}`); });
