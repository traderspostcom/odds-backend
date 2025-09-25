// src/index.js (ESM) — Odds Backend on Render
// Routes:
// - GET /health
// - GET /diag/provider
// - GET /api/diag/scan/:sport?limit=N                     (cheap diag)
// - GET /api/telegram/test?text=...&force=1               (free TG ping)
// - GET /api/scan/mock?telegram=bool&force=1&bypass=1     (free synthetic alert)
// - GET /api/scan/:sport?limit=N&offset=K&telegram=bool&force=1&bypass=1
// - GET /api/debug/snapshot/:sport?limit=N&offset=K       (cheap snapshot)
// - GET /api/debug/analyze/:sport?limit=N&offset=K&bypass=1

import express from "express";
import cors from "cors";

import {
  getNFLH2HNormalized,
  getMLBH2HNormalized,
  getNCAAFH2HNormalized,
  diagListBooksForSport,
} from "./fetchers.js";

import { analyzeMarket } from "../sharpEngine.js";

// ----------------------------- process guards -----------------------------
process.on("unhandledRejection", (err) => {
  console.error("unhandledRejection", String(err?.stack || err));
});
process.on("uncaughtException", (err) => {
  console.error("uncaughtException", String(err?.stack || err));
});

// ----------------------------- express app --------------------------------
const app = express();
app.use(cors());
app.use(express.json({ limit: "256kb" }));

const PORT = process.env.PORT || 3000;

// ------------------------------- helpers ----------------------------------
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
function mask(str, keep = 4) {
  if (!str) return false;
  const s = String(str);
  return s.length <= keep ? s : `${s.slice(0, keep)}…(${s.length})`;
}
function guard(fn) {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      console.error("handler_error", {
        path: req.path,
        msg: String((err && err.message) || err),
        stack: err && err.stack,
      });
      res.status(500).json({ ok: false, error: "internal_error", detail: String(err?.message || err) });
    }
  };
}

// ------------------------------ SCAN KEY gate -----------------------------
function gateScan(req, res, next) {
  const required = process.env.SCAN_KEY;
  if (!required) return next(); // disabled if no key is set
  const provided = req.get("x-scan-key") || req.query.scan_key || "";
  if (provided !== required) {
    return res.status(401).json({ ok: false, error: "scan_key_required" });
  }
  next();
}

// ------------------------------- Telegram ---------------------------------
async function sendTelegram(text, { force = false } = {}) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  const auto = BOOL(process.env.AUTO_TELEGRAM, false);

  if (!token || !chatId) {
    return { ok: false, error: "telegram_not_configured" };
  }
  if (!auto && !force) {
    return { ok: false, skipped: true, reason: "AUTO_TELEGRAM=false and force!=1" };
  }

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const body = { chat_id: chatId, text, disable_web_page_preview: true };

  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({}));
    return { ok: r.ok && j.ok, status: r.status, body: j };
  } catch (e) {
    console.error("telegram_error", String(e?.stack || e));
    return { ok: false, error: String(e) };
  }
}

function formatAlertForTelegram(a) {
  const when = a?.game?.start_time_utc
    ? new Date(a.game.start_time_utc).toLocaleString("en-US", { timeZone: "America/New_York" })
    : "-";
  const book = a?.lines?.book || "-";
  const line = a?.lines?.sharp_entry != null
    ? (a.lines.sharp_entry >= 0 ? `+${a.lines.sharp_entry}` : `${a.lines.sharp_entry}`)
    : "-";
  const tag = Array.isArray(a?.render?.tags) ? a.render.tags.join(",") : (a?.source || "").toUpperCase();

  return [
    `${a?.render?.emoji || "🚨"} ${a?.render?.title || "ALERT"}`,
    `${a?.render?.strength || ""}  [${tag}]`,
    `Pick: ${a?.sharp_side?.team} (${a?.sharp_side?.side}) @ ${line} on ${book}`,
    `Game: ${a?.game?.away} @ ${a?.game?.home} | ${when} ET`,
  ].join("\n");
}

// -------------------------------- Routes ----------------------------------

// Health (FREE)
app.get("/health", guard(async (req, res) => {
  const env = {
    HARD_KILL: BOOL(process.env.HARD_KILL, false),
    SCAN_ENABLED: BOOL(process.env.SCAN_ENABLED, false),
    AUTO_TELEGRAM: BOOL(process.env.AUTO_TELEGRAM, false),
    DIAG: BOOL(process.env.DIAG, true),

    MANUAL_MAX_JOBS: Number(process.env.MANUAL_MAX_JOBS || 1),
    MAX_JOBS_PER_SPORT: Number(process.env.MAX_JOBS_PER_SPORT || 1),
    MAX_EVENTS_PER_CALL: Number(process.env.MAX_EVENTS_PER_CALL || 1),

    ENABLE_NFL_H2H: BOOL(process.env.ENABLE_NFL_H2H, true),
    ENABLE_NFL_H1: BOOL(process.env.ENABLE_NFL_H1, false),
    ENABLE_MLB_H2H: BOOL(process.env.ENABLE_MLB_H2H, true),
    ENABLE_MLB_F5_H2H: BOOL(process.env.ENABLE_MLB_F5_H2H, false),
    ENABLE_NCAAF_H2H: BOOL(process.env.ENABLE_NCAAF_H2H, true),
    ENABLE_NCAAF_SPREADS: BOOL(process.env.ENABLE_NCAAF_SPREADS, false),
    ENABLE_NCAAF_TOTALS: BOOL(process.env.ENABLE_NCAAF_TOTALS, false),

    ODDS_API_ENABLED: BOOL(process.env.ODDS_API_ENABLED, true),
    ODDS_API_KEY_present: !!process.env.ODDS_API_KEY,
    ODDS_API_REGION: process.env.ODDS_API_REGION || "eu",
    BOOKS_WHITELIST: process.env.BOOKS_WHITELIST || "",
    ALERT_BOOKS: process.env.ALERT_BOOKS || "",

    LEAN_THRESHOLD: Number(process.env.LEAN_THRESHOLD || 0.01),
    STRONG_THRESHOLD: Number(process.env.STRONG_THRESHOLD || 0.035),
    OUTLIER_DOG_CENTS_LEAN: Number(process.env.OUTLIER_DOG_CENTS_LEAN || 10),
    OUTLIER_DOG_CENTS_STRONG: Number(process.env.OUTLIER_DOG_CENTS_STRONG || 18),
    OUTLIER_FAV_CENTS_LEAN: Number(process.env.OUTLIER_FAV_CENTS_LEAN || 7),
    OUTLIER_FAV_CENTS_STRONG: Number(process.env.OUTLIER_FAV_CENTS_STRONG || 12),

    RETRY_429_MAX: Number(process.env.RETRY_429_MAX || 0),
    RATE_LIMIT_MS: Number(process.env.RATE_LIMIT_MS || 1200),
    CACHE_TTL_SECONDS: Number(process.env.CACHE_TTL_SECONDS || 90),

    TELEGRAM_CHAT_ID: String(process.env.TELEGRAM_CHAT_ID || ""),
    SCAN_KEY_present: !!process.env.SCAN_KEY,
  };
  res.json({ ok: true, env, ts: new Date().toISOString() });
}));

// Provider probe (CHEAP)
app.get("/diag/provider", guard(async (req, res) => {
  const enabled = BOOL(process.env.ODDS_API_ENABLED, true);
  const key = process.env.ODDS_API_KEY;
  if (!enabled) return res.json({ ok: true, enabled, note: "provider disabled" });
  if (!key) return res.status(400).json({ ok: false, error: "no_api_key" });

  const url = `https://api.the-odds-api.com/v4/sports/?apiKey=${encodeURIComponent(key)}`;
  const r = await fetch(url);
  const txt = await r.text();
  res.json({ ok: r.ok, status: r.status, body: safeJson(txt) });
}));

// Books per game (CHEAP) — gated
app.get("/api/diag/scan/:sport", gateScan, guard(async (req, res) => {
  const sport = String(req.params.sport || "").toLowerCase();
  const limit = Number(req.query.limit || 3);
  const raw = await diagListBooksForSport(sport, { limit });
  if (!Array.isArray(raw)) return res.status(400).json({ ok: false, error: "unsupported_sport" });

  res.json({
    ok: true,
    sport,
    limit,
    pulled: raw.length,
    events: raw.map(g => ({
      gameId: g.id,
      away: g.away,
      home: g.home,
      commence_time: g.commence_time,
      offers_count: Array.isArray(g.books) ? g.books.length : 0,
      books: g.books || [],
    })),
  });
}));

// Telegram test (FREE)
app.get("/api/telegram/test", guard(async (req, res) => {
  const force = req.query.force === "1";
  const text = req.query.text || "Hello from Odds Backend";
  const r = await sendTelegram(String(text), { force });
  res.json(r);
}));

// Synthetic alert (FREE)
app.get("/api/scan/mock", gateScan, guard(async (req, res) => {
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
      start_time_utc: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    },
    sharp_side: { side: "home", team: "Mockers", confidence: "strong" },
    lines: { sharp_entry: -105, current_consensus: -105, direction: "flat", book: null },
    score: 3,
    signals: [
      { key: "split_gap", label: "Handle > Tickets by 20%", weight: 2 },
      { key: "hold", label: "Hold 2%", weight: 1 },
    ],
    render: {
      title: "SHARP ALERT – NFL Testers @ Mockers",
      emoji: "🔁",
      strength: "🟢 Strong",
      tags: ["SPLITS"],
    },
    meta: { generated_at: new Date().toISOString() },
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
    planned_jobs: ["NFL H2H (mock)"],
    alerts: [alert],
  });
}));

// Main scan (COSTS when ODDS_API_ENABLED=true) — gated
app.get("/api/scan/:sport", gateScan, guard(async (req, res) => {
  const origin = req.get("x-scan-origin") || req.query.from || "unknown";
  const ua     = req.get("user-agent") || "-";
  const ip     = req.get("cf-connecting-ip") || req.get("x-forwarded-for") || req.ip || "-";
  const sport  = String(req.params.sport || "").toLowerCase();
  const send   = req.query.telegram === "true";
  const oddsOn = String(process.env.ODDS_API_ENABLED || "true").toLowerCase();
  console.log(
    "[scan]",
    JSON.stringify({ sport, send, origin, ip, ua, odds_api_enabled: oddsOn, qs: req.query })
  );

  const limit  = Number(req.query.limit  || process.env.MAX_EVENTS_PER_CALL || 1);
  const offset = Number(req.query.offset || 0);
  const telegram = send;
  const force  = req.query.force  === "1";
  const bypass = req.query.bypass === "1";

  const plannedJobs = [];
  const jobs = [];

  if (sport === "nfl") {
    if (BOOL(process.env.ENABLE_NFL_H2H, true)) { plannedJobs.push("NFL H2H"); jobs.push(getNFLH2HNormalized); }
  } else if (sport === "mlb") {
    if (BOOL(process.env.ENABLE_MLB_H2H, true)) { plannedJobs.push("MLB H2H"); jobs.push(getMLBH2HNormalized); }
  } else if (sport === "ncaaf") {
    if (BOOL(process.env.ENABLE_NCAAF_H2H, true)) { plannedJobs.push("NCAAF H2H"); jobs.push(getNCAAFH2HNormalized); }
  } else {
    return res.status(400).json({ error: "unsupported_sport", sport });
  }

  if (!jobs.length) {
    return res.json({
      sport, limit, pulled: 0, analyzed: 0, sent_to_telegram: 0,
      timestamp_et: nowET(), planned_jobs: plannedJobs, alerts: [],
      note: "No jobs enabled via env for this sport.",
    });
  }

  const snapshots = [];
  for (const job of jobs) {
    const take = Math.max(0, (offset || 0) + (limit || 0));
    try {
      const got = await job({ limit: take || limit || 1, offset: 0 });
      if (Array.isArray(got) && got.length) {
        const sliced = offset > 0 ? got.slice(offset, offset + limit) : got.slice(0, limit);
        snapshots.push(...sliced);
      }
    } catch (e) {
      console.error("snapshot_fetch_error", sport, String(e?.stack || e));
    }
  }

  const pulled = snapshots.length;
  const alerts = [];
  let analyzed = 0;
  let sent_to_telegram = 0;

  for (const snap of snapshots) {
    try {
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
        source_meta: snap.source_meta || {},
      };

      const a = analyzeMarket(normalized, { bypassDedupe: bypass });
      if (a) { analyzed += 1; alerts.push(a); }
    } catch (e) {
      console.error("analyze_error", String(e?.stack || e));
    }
  }

  if (telegram && alerts.length) {
    for (const a of alerts) {
      try {
        const text = formatAlertForTelegram(a);
        const r = await sendTelegram(text, { force });
        if (r.ok) sent_to_telegram += 1;
        else console.warn("telegram_send_fail", r);
      } catch (e) {
        console.error("telegram_send_error", String(e?.stack || e));
      }
    }
  }

  res.json({
    sport, limit, pulled, analyzed, sent_to_telegram,
    timestamp_et: nowET(), planned_jobs: plannedJobs, alerts,
  });
}));

// Debug: one normalized snapshot (CHEAP) — gated
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
  res.json({
    ok: !!snap, sport, limit, has: !!snap,
    keys: snap ? Object.keys(snap) : [], snapshot: snap || null,
  });
}));

// Debug: run analyzer once (CHEAP except provider call) — gated
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

  let analysis = null;
  if (normalized) {
    try {
      analysis = analyzeMarket(normalized, { bypassDedupe: bypass });
    } catch (e) {
      console.error("debug_analyze_error", String(e?.stack || e));
    }
  }

  res.json({
    ok: true, sport, limit,
    has_snapshot: !!normalized,
    snapshot_keys: normalized ? Object.keys(normalized) : [],
    analysis_null: !analysis, analysis: analysis || null,
  });
}));

// Root ping (FREE)
app.get("/", (req, res) => res.json({ ok: true, name: "odds-backend", ts: new Date().toISOString() }));

// ------------------------------ start server ------------------------------
app.listen(PORT, () => {
  console.log(`odds-backend listening on :${PORT}`);
});
