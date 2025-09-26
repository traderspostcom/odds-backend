// src/index.js  (ESM)
// Odds Backend – Render
// ----------------------------------------------

import express from "express";
import cors from "cors";

import {
  getNFLH2HNormalized,
  getMLBH2HNormalized,
  getNCAAFH2HNormalized,
  diagListBooksForSport,
} from "./fetchers.js";

import { analyzeMarket } from "../sharpEngine.js";

// ----------------------------------------------
// App bootstrap
// ----------------------------------------------
const app = express();
app.use(cors());
app.use(express.json({ limit: "256kb" }));

const PORT = process.env.PORT || 10000;

// ----------------------------------------------
// Small helpers
// ----------------------------------------------
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
  try {
    return JSON.parse(s);
  } catch {
    return String(s);
  }
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
      res.status(500).json({ ok: false, error: "internal_error" });
    }
  };
}

// Optional scan-key gate
function gateScan(req, res, next) {
  const required = process.env.SCAN_KEY;
  if (!required) return next();
  const provided = req.get("x-scan-key") || req.query.scan_key || "";
  if (provided !== required) {
    return res.status(401).json({ ok: false, error: "scan_key_required" });
  }
  next();
}

// ----------------------------------------------
// Telegram helpers
// ----------------------------------------------
async function sendTelegram(text, { force = false } = {}) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  const auto = BOOL(process.env.AUTO_TELEGRAM, false);

  if (!token || !chatId) return { ok: false, error: "telegram_not_configured" };
  if (!auto && !force) return { ok: false, skipped: true, reason: "AUTO_TELEGRAM=false and force!=1" };

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const body = {
    chat_id: chatId,
    text,
    parse_mode: "Markdown",
    disable_web_page_preview: true,
  };

  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok && j.ok, status: r.status, body: j };
}

// Map incoming market keys to the labels you want to SEE in Telegram
function mapMarketLabel(raw = "") {
  const s = String(raw).toLowerCase().replace(/\s+/g, "");
  // Any H2H → ML
  if (s.includes("h2h")) return "ML";
  // First 5 / 1st 5 / first_half → F5
  if (s.includes("1st5") || s.includes("first5") || s.includes("f5") || s.includes("firsthalf") || s.includes("1sthalf"))
    return "F5";
  // Spreads / Totals keep short codes
  if (s.includes("spreads")) return "SP";
  if (s.includes("totals")) return "TOT";
  return (raw || "ML").toUpperCase();
}

function fmtEVFromSignals(signals = []) {
  // Try to locate an ev_pct-like signal
  const ev = (signals || []).find(
    s => (s.key || "").toLowerCase().includes("ev") && /%/.test(String(s.label || ""))
  );
  if (!ev) return null;
  // Extract number from something like "+6.28% EV"
  const m = String(ev.label).match(/([-+]?\d+(?:\.\d+)?)\s*%/);
  return m ? Number(m[1]) : null;
}

function fmtTimeET(iso) {
  if (!iso) return "TBD";
  try {
    const dt = new Date(iso);
    return dt.toLocaleString("en-US", {
      timeZone: "America/New_York",
      month: "short",
      day: "2-digit",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return String(iso);
  }
}

// ---------- Telegram formatter (ALL the visual tweaks you asked for) ----------
function formatAlertForTelegram(a) {
  // Title line
  const emoji = a?.render?.emoji || "🚨";
  const title = `*GoSignals Alert*`;
  const strength = a?.render?.strength || ""; // e.g., 🟡 Lean / 🟢 Strong

  // Matchup + time
  const away = a?.game?.away || a?.away || "-";
  const home = a?.game?.home || a?.home || "-";
  const whenET = fmtTimeET(a?.game?.start_time_utc || a?.commence_time);

  // Best line / side
  const sideTeam = a?.sharp_side?.team || "-";
  const sideSide = a?.sharp_side?.side || "-";
  const price = a?.lines?.sharp_entry != null ? a.lines.sharp_entry : null;
  const book = a?.lines?.book || "";
  const priceTxt = price == null ? "?" : (price >= 0 ? `+${price}` : `${price}`);

  // EV
  const evPct = fmtEVFromSignals(a?.signals || []);
  const evLine = evPct != null ? `\n💹 *EV*: ${evPct.toFixed(2)}%` : "";

  // Layout with spacing
  let msg = "";
  msg += `${emoji} ${title}\n`;
  if (strength) msg += `_${strength}_\n`;
  msg += `\n`;
  msg += `🗓 ${whenET} ET\n`;
  msg += `⚔️ ${away} @ ${home}\n`;
  msg += `\n`;
  msg += `🎯 Market: *${mapMarketLabel(a?.market)}*\n`;
  msg += `\n`;
  msg += `✅ Pick: *${sideTeam}* (${sideSide}) @ *${priceTxt}*  on *${book || "—"}*\n`;
  msg += evLine; // includes its own leading \n if present
  msg += `\n`;
  if (Array.isArray(a?.render?.tags) && a.render.tags.length) {
    msg += `\n🏷 ${a.render.tags.join(", ")}`;
  }
  return msg.trim();
}

// ----------------------------------------------
// ROUTES
// ----------------------------------------------

// Health
app.get(
  "/health",
  guard(async (_req, res) => {
    const env = {
      HARD_KILL:       BOOL(process.env.HARD_KILL, false),
      SCAN_ENABLED:    BOOL(process.env.SCAN_ENABLED, true),
      AUTO_TELEGRAM:   BOOL(process.env.AUTO_TELEGRAM, false),
      DIAG:            BOOL(process.env.DIAG, true),

      MANUAL_MAX_JOBS:    Number(process.env.MANUAL_MAX_JOBS || 1),
      MAX_JOBS_PER_SPORT: Number(process.env.MAX_JOBS_PER_SPORT || 1),
      MAX_EVENTS_PER_CALL:Number(process.env.MAX_EVENTS_PER_CALL || 10),

      ENABLE_NFL_H2H:   BOOL(process.env.ENABLE_NFL_H2H, true),
      ENABLE_NFL_H1:    BOOL(process.env.ENABLE_NFL_H1, true),
      ENABLE_MLB_H2H:   BOOL(process.env.ENABLE_MLB_H2H, true),
      ENABLE_MLB_F5_H2H:BOOL(process.env.ENABLE_MLB_F5_H2H, true),
      ENABLE_NCAAF_H2H: BOOL(process.env.ENABLE_NCAAF_H2H, true),
      ENABLE_NCAAF_SPREADS: BOOL(process.env.ENABLE_NCAAF_SPREADS, false),
      ENABLE_NCAAF_TOTALS:  BOOL(process.env.ENABLE_NCAAF_TOTALS, false),

      ODDS_API_ENABLED:   BOOL(process.env.ODDS_API_ENABLED, true),
      ODDS_API_KEY_present: !!process.env.ODDS_API_KEY,
      ODDS_API_REGION:    process.env.ODDS_API_REGION || "",
      BOOKS_WHITELIST:    process.env.BOOKS_WHITELIST || "",
      ALERT_BOOKS:        process.env.ALERT_BOOKS || "",

      LEAN_THRESHOLD: Number(process.env.LEAN_THRESHOLD || 0.01),
      STRONG_THRESHOLD: Number(process.env.STRONG_THRESHOLD || 0.02),
      OUTLIER_DOG_CENTS_LEAN:   Number(process.env.OUTLIER_DOG_CENTS_LEAN || 10),
      OUTLIER_DOG_CENTS_STRONG: Number(process.env.OUTLIER_DOG_CENTS_STRONG || 18),
      OUTLIER_FAV_CENTS_LEAN:   Number(process.env.OUTLIER_FAV_CENTS_LEAN || 7),
      OUTLIER_FAV_CENTS_STRONG: Number(process.env.OUTLIER_FAV_CENTS_STRONG || 12),

      RETRY_429_MAX:     Number(process.env.RETRY_429_MAX || 0),
      RATE_LIMIT_MS:     Number(process.env.RATE_LIMIT_MS || 1200),
      CACHE_TTL_SECONDS: Number(process.env.CACHE_TTL_SECONDS || 60),

      TELEGRAM_CHAT_ID: String(process.env.TELEGRAM_CHAT_ID || ""),
      SCAN_KEY_present: !!process.env.SCAN_KEY,
    };
    res.json({ ok: true, env, ts: new Date().toISOString() });
  })
);

// Provider sanity (cheap)
app.get(
  "/diag/provider",
  guard(async (_req, res) => {
    const enabled = BOOL(process.env.ODDS_API_ENABLED, true);
    const key = process.env.ODDS_API_KEY;
    if (!enabled) return res.json({ ok: true, enabled, note: "provider disabled" });
    if (!key) return res.status(400).json({ ok: false, error: "no_api_key" });

    const url = `https://api.the-odds-api.com/v4/sports/?apiKey=${encodeURIComponent(key)}`;
    const r = await fetch(url);
    const txt = await r.text();
    res.json({ ok: r.ok, status: r.status, body: safeJson(txt) });
  })
);

// Books per game (diagnostic) — gated
app.get(
  "/api/diag/scan/:sport",
  gateScan,
  guard(async (req, res) => {
    const sport = String(req.params.sport || "").toLowerCase();
    const limit = Number(req.query.limit || 3);

    const raw = await diagListBooksForSport(sport, { limit });
    if (!Array.isArray(raw)) return res.status(400).json({ ok: false, error: "unsupported_sport" });

    res.json({
      ok: true,
      sport,
      limit,
      pulled: raw.length,
      events: raw.map((g) => ({
        gameId: g.id,
        away: g.away,
        home: g.home,
        commence_time: g.commence_time,
        offers_count: Array.isArray(g.books) ? g.books.length : 0,
        books: g.books || [],
      })),
    });
  })
);

// Telegram test
app.get(
  "/api/telegram/test",
  guard(async (req, res) => {
    const force = req.query.force === "1";
    const text = req.query.text || "Hello from Odds Backend";
    const r = await sendTelegram(String(text), { force });
    res.json(r);
  })
);

// Synthetic alert (zero provider credits)
app.get(
  "/api/scan/mock",
  guard(async (req, res) => {
    const telegram = req.query.telegram === "true";
    const force = req.query.force === "1";
    const bypass = req.query.bypass === "1";

    const alert = {
      type: bypass ? "forced" : "initial",
      source: "ev",
      sport: "nfl",
      market: "NFL H2H",
      game_id: `mock-${Date.now()}`,
      game: {
        away: "Testers",
        home: "Mockers",
        start_time_utc: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      },
      sharp_side: { side: "home", team: "Mockers", confidence: "strong" },
      lines: { sharp_entry: -105, current_consensus: -105, direction: "flat", book: "draftkings" },
      score: 3,
      signals: [
        { key: "ev_pct", label: "+6.20% EV", weight: 2 },
        { key: "hold", label: "Hold 2%", weight: 1 },
      ],
      render: {
        title: "GoSignals Alert – NFL Testers @ Mockers",
        emoji: "🔁",
        strength: "🟢 Strong",
        tags: ["EV"],
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
  })
);

// Main scan — gated
app.get(
  "/api/scan/:sport",
  gateScan,
  guard(async (req, res) => {
    const origin = req.get("x-scan-origin") || req.query.from || "unknown";
    const ua = req.get("user-agent") || "-";
    const ip = req.get("cf-connecting-ip") || req.get("x-forwarded-for") || req.ip || "-";
    const sport = String(req.params.sport || "").toLowerCase();
    const sendQueryFlag = req.query.telegram === "true"; // manual override
    const oddsOn = String(process.env.ODDS_API_ENABLED || "true").toLowerCase();

    console.log(
      `[scan] sport=${sport} send=${sendQueryFlag} origin=${origin} ip=${ip} ua="${ua}" odds_api_enabled=${oddsOn} qs=${JSON.stringify(
        req.query
      )}`
    );

    const limit = Number(req.query.limit || process.env.MAX_EVENTS_PER_CALL || 3);
    const offset = Number(req.query.offset || 0);
    const force = req.query.force === "1";
    const bypass = req.query.bypass === "1";

    const plannedJobs = [];
    const jobs = [];

    if (sport === "nfl") {
      if (BOOL(process.env.ENABLE_NFL_H2H, true)) {
        plannedJobs.push("NFL H2H");
        jobs.push(getNFLH2HNormalized);
      }
    } else if (sport === "mlb") {
      if (BOOL(process.env.ENABLE_MLB_H2H, true)) {
        plannedJobs.push("MLB H2H");
        jobs.push(getMLBH2HNormalized);
      }
      if (BOOL(process.env.ENABLE_MLB_F5_H2H, false)) {
        plannedJobs.push("MLB F5 H2H");
        // If/when you add a dedicated F5 fetcher, push it here as another job.
      }
    } else if (sport === "ncaaf") {
      if (BOOL(process.env.ENABLE_NCAAF_H2H, true)) {
        plannedJobs.push("NCAAF H2H");
        jobs.push(getNCAAFH2HNormalized);
      }
    } else {
      return res.status(400).json({ error: "unsupported_sport", sport });
    }

    if (!jobs.length) {
      return res.json({
        sport,
        limit,
        pulled: 0,
        analyzed: 0,
        sent_to_telegram: 0,
        timestamp_et: nowET(),
        planned_jobs: plannedJobs,
        alerts: [],
        note: "No jobs enabled via env for this sport.",
      });
    }

    // fetch snapshots (ask for offset+limit then slice)
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
        commence_time:
          snap?.game?.start_time_utc || snap.start_time_utc || snap.commence_time || null,
        game: snap.game || {
          away: snap.away,
          home: snap.home,
          start_time_utc: snap.commence_time,
        },
        offers: snap.offers || [],
        source_meta: snap.source_meta || {},
      };

      const a = analyzeMarket(normalized, { bypassDedupe: bypass });
      if (a) {
        analyzed += 1;
        alerts.push(a);
      }
    }

    const shouldSend =
      sendQueryFlag || // explicit ?telegram=true
      BOOL(process.env.AUTO_TELEGRAM, false);

    if (shouldSend && alerts.length) {
      for (const a of alerts) {
        const text = formatAlertForTelegram(a);
        const r = await sendTelegram(text, { force });
        if (r.ok) sent_to_telegram += 1;
      }
    }

    res.json({
      sport,
      limit,
      pulled,
      analyzed,
      sent_to_telegram,
      timestamp_et: nowET(),
      planned_jobs: plannedJobs,
      alerts,
    });
  })
);

// Root
app.get("/", (_req, res) => res.json({ ok: true, name: "odds-backend", ts: new Date().toISOString() }));

// Start
app.listen(PORT, () => {
  console.log(`odds-backend listening on :${PORT}`);
});
