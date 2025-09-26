// src/index.js (ESM) — Odds Backend (Render)
// ----------------------------------------------------

import express from "express";
import cors from "cors";

// Provider fetchers (you already have these files)
import {
  getNFLH2HNormalized,
  getMLBH2HNormalized,
  getNCAAFH2HNormalized,
  diagListBooksForSport,
  // if you later add F5 fetcher, import it here:
  // getMLBF5H2HNormalized,
} from "./fetchers.js";

// Sharp analyzer (you already have this file)
import { analyzeMarket } from "../sharpEngine.js";

// ----------------------------------------------------
// App bootstrap
// ----------------------------------------------------
const app = express();
app.use(cors());
app.use(express.json({ limit: "256kb" }));

const PORT = Number(process.env.PORT || 10000);

// ----------------------------------------------------
// Utilities
// ----------------------------------------------------
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

function safeJson(s) {
  try { return JSON.parse(s); } catch { return String(s); }
}

function guard(fn) {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      console.error("handler_error", {
        path: req.path,
        message: (err && err.message) || String(err),
        stack: err && err.stack
      });
      res.status(500).json({ ok: false, error: "internal_error" });
    }
  };
}

// ----------------------------------------------------
// Scan gate (optional) — requires x-scan-key if SCAN_KEY is set
// ----------------------------------------------------
function gateScan(req, res, next) {
  const required = process.env.SCAN_KEY;
  if (!required) return next();
  const provided = req.get("x-scan-key") || req.query.scan_key || "";
  if (provided !== required) {
    return res.status(401).json({ ok: false, error: "scan_key_required" });
  }
  next();
}

// ----------------------------------------------------
// Telegram helpers
// Node 20+ has global fetch; if you’re on older Node, add: import fetch from "node-fetch";
// ----------------------------------------------------
async function sendTelegram(text, { force = false } = {}) {
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  const auto   = BOOL(process.env.AUTO_TELEGRAM, false);

  if (!token || !chatId) {
    return { ok: false, error: "telegram_not_configured" };
  }
  // Only send automatically if AUTO_TELEGRAM=true OR the call forced it
  if (!auto && !force) {
    return { ok: false, skipped: true, reason: "AUTO_TELEGRAM=false and not forced" };
  }

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const body = {
    chat_id: chatId,
    text,
    parse_mode: "Markdown",
    disable_web_page_preview: true
  };

  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });

  const j = await r.json().catch(() => ({}));
  const ok = !!(r.ok && j && j.ok !== false);
  if (!ok) {
    console.error("telegram_send_failed", { status: r.status, body: j });
  }
  return { ok, status: r.status, body: j };
}

/**
 * Map market keys to compact labels for TG
 */
function mapMarketKey(market = "") {
  const norm = String(market).toLowerCase().replace(/[_\-\s]/g, "");
  if (norm === "h2h" || norm === "h2h1st5innings") return "ML";
  if (norm === "totals" || norm === "totals1st5innings") return "TOT";
  if (norm === "spreads" || norm === "spreads1st5innings") return "SP";
  if (norm === "teamtotals" || norm === "teamtotals1st5innings") return "TT";
  return (market || "").toUpperCase();
}

/**
 * Format one alert object for Telegram.
 * If your analyzer attaches ev/kelly/strength/tags, they’ll show up.
 */
// ---- replace your existing formatter with this ----
function formatAlertForTelegram(a) {
  // helpers
  const pick = (key) => (Array.isArray(a?.signals) ? a.signals.find(s => s.key === key) : null);
  const etTime = (() => {
    const iso = a?.game?.start_time_utc;
    if (!iso) return "TBD";
    try {
      const dt = new Date(iso);
      const date = new Intl.DateTimeFormat("en-US", {
        timeZone: "America/New_York",
        month: "short", day: "numeric"
      }).format(dt);
      const time = new Intl.DateTimeFormat("en-US", {
        timeZone: "America/New_York",
        hour: "numeric", minute: "2-digit"
      }).format(dt);
      return `${date}, ${time} ET`;
    } catch { return "TBD"; }
  })();

  // market label
  const marketRaw = String(a?.market || "").toUpperCase();
  const isF5 = /F5/.test(marketRaw);
  const marketLabel = isF5 ? "Moneyline – 1st 5 Innings (ML F5)" : "Moneyline (ML)";

  // EV% and Hold (pulled from signals labels if present)
  const evSig   = pick("ev_pct");
  const holdSig = pick("hold");
  const evText   = evSig?.label?.replace(/\s+/g, " ").trim() || null;        // e.g., "+6.28% EV"
  const holdText = holdSig?.label?.replace(/\s+/g, " ").trim() || null;      // e.g., "Hold 3.71%"

  // pick line
  const side  = a?.sharp_side?.side || "-";
  const team  = a?.sharp_side?.team || "-";
  const book  = a?.lines?.book || "-";
  const entry = a?.lines?.sharp_entry;
  const price = (entry != null)
    ? (entry > 0 ? `+${entry}` : `${entry}`)
    : "-";

  // header strength / tags
  const strength = a?.render?.strength || "Lean";
  const tags = Array.isArray(a?.render?.tags) ? a.render.tags.join(", ") : (a?.source || "").toUpperCase();

  // Build message (plain text with clear spacing)
  const lines = [];
  lines.push("🔔 GoSignals Alert");
  lines.push(`Mode: ${tags || "—"}`);
  lines.push("");
  lines.push(`🗓️ ${etTime}`);
  lines.push(`⚔️ ${a?.game?.away || a?.away || "TBD"} @ ${a?.game?.home || a?.home || "TBD"}`);
  lines.push("");
  lines.push(`🎯 Market: ${marketLabel}`);
  lines.push("");
  lines.push(`✅ Pick: ${team} (${side})  @ ${price}  on ${book}`);
  if (evText)   lines.push(`📈 ${evText}`);
  if (holdText) lines.push(`💰 ${holdText}`);

  return lines.join("\n");
}


  // Strength/tag badges if your analyzer provides them
  const strength = a?.render?.strength || a?.strength || "";
  const tagLabel = Array.isArray(a?.render?.tags) ? a.render.tags.join(", ")
                    : (a?.source ? String(a.source).toUpperCase() : "");

  const ev = (typeof a?.metrics?.ev === "number") ? a.metrics.ev : (typeof a?.ev === "number" ? a.ev : null);
  const kelly = (typeof a?.metrics?.kelly === "number") ? a.metrics.kelly : (typeof a?.kelly === "number" ? a.kelly : null);

  const pieces = [];
  pieces.push(`${a?.render?.emoji || "🚨"} *Sharp Signal*${strength ? ` ${strength}` : ""}${tagLabel ? `  [${tagLabel}]` : ""}`);
  pieces.push(`🕒 ${tET} ET`);
  pieces.push(`🏟️ ${away} @ ${home}`);
  pieces.push(`🎯 Market: ${market}`);
  pieces.push(`🧭 Pick: *${sharpTeam}* @ ${sharpLine} on *${onBook}*`);
  if (ev != null || kelly != null) {
    const evStr = ev != null ? `EV: ${ev.toFixed ? ev.toFixed(2) : ev}` : null;
    const kStr  = kelly != null ? `Kelly: ${kelly.toFixed ? kelly.toFixed(2) : kelly}` : null;
    pieces.push(`📈 ${[evStr, kStr].filter(Boolean).join(" | ")}`);
  }
  if (a?.hold != null) {
    pieces.push(`💰 Hold: ${(a.hold * 100).toFixed(2)}%`);
  }

  return pieces.join("\n");
}

// ----------------------------------------------------
// Routes
// ----------------------------------------------------

// Health: shows effective env (echo-only where appropriate)
app.get("/health", guard(async (_req, res) => {
  const env = {
    HARD_KILL: BOOL(process.env.HARD_KILL, false),
    SCAN_ENABLED: BOOL(process.env.SCAN_ENABLED, true),
    AUTO_TELEGRAM: BOOL(process.env.AUTO_TELEGRAM, false),
    DIAG: BOOL(process.env.DIAG, true),

    MANUAL_MAX_JOBS: Number(process.env.MANUAL_MAX_JOBS || 1),
    MAX_JOBS_PER_SPORT: Number(process.env.MAX_JOBS_PER_SPORT || 1),
    MAX_EVENTS_PER_CALL: Number(process.env.MAX_EVENTS_PER_CALL || 10),

    ENABLE_NFL_H2H: BOOL(process.env.ENABLE_NFL_H2H, true),
    ENABLE_NFL_H1:  BOOL(process.env.ENABLE_NFL_H1, true),
    ENABLE_MLB_H2H: BOOL(process.env.ENABLE_MLB_H2H, true),
    ENABLE_MLB_F5_H2H: BOOL(process.env.ENABLE_MLB_F5_H2H, true),
    ENABLE_NCAAF_H2H: BOOL(process.env.ENABLE_NCAAF_H2H, true),
    ENABLE_NCAAF_SPREADS: BOOL(process.env.ENABLE_NCAAF_SPREADS, false),
    ENABLE_NCAAF_TOTALS: BOOL(process.env.ENABLE_NCAAF_TOTALS, false),

    ODDS_API_ENABLED:      BOOL(process.env.ODDS_API_ENABLED, true),
    ODDS_API_KEY_present: !!process.env.ODDS_API_KEY,
    ODDS_API_REGION: process.env.ODDS_API_REGION || "",
    BOOKS_WHITELIST: process.env.BOOKS_WHITELIST || "",
    ALERT_BOOKS:     process.env.ALERT_BOOKS || "",

    LEAN_THRESHOLD: Number(process.env.LEAN_THRESHOLD || 0.01),
    STRONG_THRESHOLD: Number(process.env.STRONG_THRESHOLD || 0.02),
    OUTLIER_DOG_CENTS_LEAN: Number(process.env.OUTLIER_DOG_CENTS_LEAN || 10),
    OUTLIER_DOG_CENTS_STRONG: Number(process.env.OUTLIER_DOG_CENTS_STRONG || 18),
    OUTLIER_FAV_CENTS_LEAN: Number(process.env.OUTLIER_FAV_CENTS_LEAN || 7),
    OUTLIER_FAV_CENTS_STRONG: Number(process.env.OUTLIER_FAV_CENTS_STRONG || 12),

    RETRY_429_MAX: Number(process.env.RETRY_429_MAX || 0),
    RATE_LIMIT_MS: Number(process.env.RATE_LIMIT_MS || 1200),
    CACHE_TTL_SECONDS: Number(process.env.CACHE_TTL_SECONDS || 60),

    TELEGRAM_CHAT_ID: String(process.env.TELEGRAM_CHAT_ID || ""),
    SCAN_KEY_present: !!process.env.SCAN_KEY,
  };

  res.json({ ok: true, env, ts: new Date().toISOString() });
}));

// Provider sanity (cheap echo)
app.get("/diag/provider", guard(async (_req, res) => {
  const enabled = BOOL(process.env.ODDS_API_ENABLED, true);
  const key = process.env.ODDS_API_KEY;
  if (!enabled) return res.json({ ok: true, enabled, note: "provider disabled" });
  if (!key) return res.status(400).json({ ok: false, error: "no_api_key" });

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
    ok: true,
    sport, limit,
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

// Telegram test endpoint
app.get("/api/telegram/test", guard(async (req, res) => {
  const force = req.query.force === "1"; // ignore AUTO_TELEGRAM if forced
  const text = String(req.query.text || "Hello from Odds Backend");
  const r = await sendTelegram(text, { force });
  res.json(r);
}));

// Synthetic alert (no provider credits)
app.get("/api/scan/mock", guard(async (req, res) => {
  const telegram = req.query.telegram === "true";
  const force = req.query.force === "1";
  const bypass = req.query.bypass === "1";

  const alert = {
    type: bypass ? "forced" : "initial",
    source: "splits",
    sport: "nfl",
    market: "NFL H2H",
    game_id: `mock-${Date.now()}`,
    game: {
      away: "Testers",
      home: "Mockers",
      start_time_utc: new Date(Date.now() + 60 * 60 * 1000).toISOString()
    },
    sharp_side: { side: "home", team: "Mockers", confidence: "strong" },
    lines: { sharp_entry: -105, current_consensus: -105, direction: "flat", book: "pinnacle" },
    metrics: { ev: 1.25, kelly: 0.35 },
    score: 3,
    signals: [
      { key: "split_gap", label: "Handle > Tickets by 20%", weight: 2 },
      { key: "hold", label: "Hold 2%", weight: 1 }
    ],
    render: {
      title: "SHARP ALERT – NFL Testers @ Mockers",
      emoji: "🔁",
      strength: "🟢 Strong",
      tags: ["SPLITS"]
    },
    meta: { generated_at: new Date().toISOString() }
  };

  let sent = 0;
  if (telegram) {
    const text = formatAlertForTelegram(alert);
    const r = await sendTelegram(text, { force });
    if (r.ok) sent = 1;
  }

  res.json({
    sport: "nfl",
    limit: 1,
    pulled: 1,
    analyzed: 1,
    sent_to_telegram: sent,
    timestamp_et: nowET(),
    planned_jobs: ["NFL H2H (mock)"],
    alerts: [alert]
  });
}));

// Main scan — gated
app.get("/api/scan/:sport", gateScan, guard(async (req, res) => {
  const origin = req.get("x-scan-origin") || req.query.from || "unknown";
  const ua     = req.get("user-agent") || "-";
  const ip     = req.get("cf-connecting-ip") || req.get("x-forwarded-for") || req.ip || "-";
  const sport  = String(req.params.sport || "").toLowerCase();

  // Send flag: on if query ?telegram=true OR AUTO_TELEGRAM=true
  const sendQueryFlag = req.query.telegram === "true";
  const autoTelegram  = BOOL(process.env.AUTO_TELEGRAM, false);
  const willSend      = sendQueryFlag || autoTelegram;

  const oddsOn = String(process.env.ODDS_API_ENABLED || "true").toLowerCase();
  console.log(
    `[scan] sport=${sport} send=${willSend} origin=${origin} ip=${ip} ua="${ua}" odds_api_enabled=${oddsOn} qs=${JSON.stringify(req.query)}`
  );

  const limit  = Number(req.query.limit  || process.env.MAX_EVENTS_PER_CALL || 10);
  const offset = Number(req.query.offset || 0);
  const force  = req.query.force  === "1"; // force TG even if AUTO_TELEGRAM=false (handled in sendTelegram)
  const bypass = req.query.bypass === "1";

  const plannedJobs = [];
  const jobs = [];

  if (sport === "nfl") {
    if (BOOL(process.env.ENABLE_NFL_H2H, true)) { plannedJobs.push("NFL H2H"); jobs.push(getNFLH2HNormalized); }
  } else if (sport === "mlb") {
    if (BOOL(process.env.ENABLE_MLB_H2H, true)) { plannedJobs.push("MLB H2H"); jobs.push(getMLBH2HNormalized); }
    if (BOOL(process.env.ENABLE_MLB_F5_H2H, false)) {
      plannedJobs.push("MLB F5 H2H");
      // if you later implement: jobs.push(getMLBF5H2HNormalized);
    }
  } else if (sport === "ncaaf") {
    if (BOOL(process.env.ENABLE_NCAAF_H2H, true)) { plannedJobs.push("NCAAF H2H"); jobs.push(getNCAAFH2HNormalized); }
  } else {
    return res.status(400).json({ ok: false, error: "unsupported_sport", sport });
  }

  if (!jobs.length) {
    return res.json({
      sport, limit, pulled: 0, analyzed: 0, sent_to_telegram: 0,
      timestamp_et: nowET(), planned_jobs: plannedJobs, alerts: [],
      note: "No jobs enabled via env for this sport."
    });
  }

  // Fetch snapshots (ask for offset+limit then slice)
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
      market: snap.market || (sport.toUpperCase() + " H2H"),
      home: snap?.game?.home || snap.home,
      away: snap?.game?.away || snap.away,
      commence_time: snap?.game?.start_time_utc || snap.start_time_utc || snap.commence_time || null,
      game: snap.game || { away: snap.away, home: snap.home, start_time_utc: snap.commence_time },
      offers: snap.offers || [],
      source_meta: snap.source_meta || {}
    };

    const a = analyzeMarket(normalized, { bypassDedupe: bypass });
    if (a) {
      analyzed += 1;
      alerts.push(a);
    }
  }

  if (willSend && alerts.length) {
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

// Debug: raw snapshot for a sport — gated
app.get("/api/debug/snapshot/:sport", gateScan, guard(async (req, res) => {
  const sport = String(req.params.sport || "").toLowerCase();
  const limit = Number(req.query.limit || 1);
  const offset = Number(req.query.offset || 0);

  let list = [];
  if (sport === "nfl") list = await getNFLH2HNormalized({ limit: limit + offset });
  else if (sport === "mlb") list = await getMLBH2HNormalized({ limit: limit + offset });
  else if (sport === "ncaaf") list = await getNCAAFH2HNormalized({ limit: limit + offset });
  else return res.json({ ok: false, sport, has: false });

  const sliced = offset > 0 ? list.slice(offset, offset + limit) : list.slice(0, limit);
  const snap = sliced[0] || null;
  res.json({ ok: !!snap, sport, limit, has: !!snap, keys: snap ? Object.keys(snap) : [], snapshot: snap || null });
}));

// Debug: run analyzer on a single normalized item — gated
app.get("/api/debug/analyze/:sport", gateScan, guard(async (req, res) => {
  const sport = String(req.params.sport || "").toLowerCase();
  const limit = Number(req.query.limit || 1);
  const offset = Number(req.query.offset || 0);
  const bypass = req.query.bypass === "1";
  const forceSport = String(req.query.forceSport || "").toLowerCase();
  const forceMarket = String(req.query.forceMarket || "");

  let list = [];
  if (sport === "nfl") list = await getNFLH2HNormalized({ limit: limit + offset });
  else if (sport === "mlb") list = await getMLBH2HNormalized({ limit: limit + offset });
  else if (sport === "ncaaf") list = await getNCAAFH2HNormalized({ limit: limit + offset });
  else return res.json({ ok: false, sport, has_snapshot: false, analysis_null: true, analysis: null });

  const sliced = offset > 0 ? list.slice(offset, offset + limit) : list.slice(0, limit);
  const snap = sliced[0] || null;
  let normalized = snap || null;

  if (normalized && (forceSport || forceMarket)) {
    normalized = { ...normalized };
    if (forceSport)  normalized.sport = forceSport;
    if (forceMarket) normalized.market = forceMarket;
  }

  const analysis = normalized ? analyzeMarket(normalized, { bypassDedupe: bypass }) : null;

  res.json({
    ok: true, sport, limit, has_snapshot: !!normalized,
    snapshot_keys: normalized ? Object.keys(normalized) : [],
    analysis_null: !analysis, analysis: analysis || null
  });
}));

// Root
app.get("/", (_req, res) => res.json({ ok: true, name: "odds-backend", ts: new Date().toISOString() }));

// Start server
app.listen(PORT, () => {
  console.log(`odds-backend listening on :${PORT}`);
});
