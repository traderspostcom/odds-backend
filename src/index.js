// src/index.js
import "dotenv/config";
import express from "express";
import cors from "cors";

// Fetchers (normalized snapshots)
import {
  getNFLH2HNormalized,
  getMLBH2HNormalized,
  getNCAAFH2HNormalized,
  diagListBooksForSport,
} from "./fetchers.js";

// Sharp analyzer (repo root)
import { analyzeMarket } from "../sharpEngine.js";

const app = express();
app.use(cors());
app.use(express.json());

const BOOL = (v) => String(v).toLowerCase() === "true";

function envSnapshot() {
  const {
    HARD_KILL, SCAN_ENABLED, AUTO_TELEGRAM, DIAG,
    MANUAL_MAX_JOBS, MAX_JOBS_PER_SPORT, MAX_EVENTS_PER_CALL,
    ENABLE_NFL_H2H, ENABLE_NFL_H1,
    ENABLE_MLB_H2H, ENABLE_MLB_F5_H2H,
    ENABLE_NCAAF_H2H, ENABLE_NCAAF_SPREADS, ENABLE_NCAAF_TOTALS,
    ODDS_API_ENABLED, ODDS_API_REGION, BOOKS_WHITELIST, ALERT_BOOKS,
    LEAN_THRESHOLD, STRONG_THRESHOLD,
    OUTLIER_DOG_CENTS_LEAN, OUTLIER_DOG_CENTS_STRONG,
    OUTLIER_FAV_CENTS_LEAN, OUTLIER_FAV_CENTS_STRONG,
    RETRY_429_MAX, RATE_LIMIT_MS, CACHE_TTL_SECONDS,
    TELEGRAM_CHAT_ID,
  } = process.env;

  return {
    // master toggles
    HARD_KILL: BOOL(HARD_KILL),
    SCAN_ENABLED: BOOL(SCAN_ENABLED),
    AUTO_TELEGRAM: BOOL(AUTO_TELEGRAM),
    DIAG: BOOL(DIAG),

    // clamps
    MANUAL_MAX_JOBS: Number(MANUAL_MAX_JOBS || 1),
    MAX_JOBS_PER_SPORT: Number(MAX_JOBS_PER_SPORT || 1),
    MAX_EVENTS_PER_CALL: Number(MAX_EVENTS_PER_CALL || 3),

    // markets we care about
    ENABLE_NFL_H2H: BOOL(ENABLE_NFL_H2H),
    ENABLE_NFL_H1: BOOL(ENABLE_NFL_H1),
    ENABLE_MLB_H2H: BOOL(ENABLE_MLB_H2H),
    ENABLE_MLB_F5_H2H: BOOL(ENABLE_MLB_F5_H2H),
    ENABLE_NCAAF_H2H: BOOL(ENABLE_NCAAF_H2H),
    ENABLE_NCAAF_SPREADS: BOOL(ENABLE_NCAAF_SPREADS),
    ENABLE_NCAAF_TOTALS: BOOL(ENABLE_NCAAF_TOTALS),

    // provider + books
    ODDS_API_ENABLED: BOOL(ODDS_API_ENABLED),
    ODDS_API_KEY_present: Boolean(process.env.ODDS_API_KEY?.length > 0),
    ODDS_API_REGION: String(ODDS_API_REGION || "us"),
    BOOKS_WHITELIST: String(BOOKS_WHITELIST || "pinnacle,draftkings,betmgm,fanduel,caesars,bet365"),
    ALERT_BOOKS: String(ALERT_BOOKS || "pinnacle"),

    // thresholds
    LEAN_THRESHOLD: Number(LEAN_THRESHOLD || 0.015),
    STRONG_THRESHOLD: Number(STRONG_THRESHOLD || 0.035),
    OUTLIER_DOG_CENTS_LEAN: Number(OUTLIER_DOG_CENTS_LEAN || 12),
    OUTLIER_DOG_CENTS_STRONG: Number(OUTLIER_DOG_CENTS_STRONG || 18),
    OUTLIER_FAV_CENTS_LEAN: Number(OUTLIER_FAV_CENTS_LEAN || 8),
    OUTLIER_FAV_CENTS_STRONG: Number(OUTLIER_FAV_CENTS_STRONG || 12),

    // pacing
    RETRY_429_MAX: Number(RETRY_429_MAX || 0),
    RATE_LIMIT_MS: Number(RATE_LIMIT_MS || 1200),
    CACHE_TTL_SECONDS: Number(CACHE_TTL_SECONDS || 30),

    TELEGRAM_CHAT_ID: TELEGRAM_CHAT_ID || "",
  };
}

async function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) throw new Error("Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID");

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const body = { chat_id: chatId, text, parse_mode: "Markdown", disable_web_page_preview: true };
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json();
  if (!data.ok) throw new Error(`Telegram error: ${JSON.stringify(data)}`);
  return data;
}

const nowET = () => {
  try { return new Date().toLocaleString("en-US", { timeZone: "America/New_York" }); }
  catch { return new Date().toISOString(); }
};

const guard = (fn) => async (req, res) => {
  try { await fn(req, res); }
  catch (e) { console.error("Route error:", e); res.status(500).json({ ok: false, error: String(e?.message || e) }); }
};

// ------------------------------ routes --------------------------------

app.get("/health", guard(async (_req, res) => {
  res.json({ ok: true, env: envSnapshot(), ts: new Date().toISOString() });
}));

app.get("/diag/provider", guard(async (_req, res) => {
  const ok = Boolean(process.env.ODDS_API_KEY?.length > 0);
  res.json({ ok, provider: "The Odds API", key_present: ok });
}));

// Books per game (no extra credits beyond odds fetch)
app.get("/api/diag/scan/:sport", guard(async (req, res) => {
  const sport = String(req.params.sport || "").toLowerCase();
  const limit = Number(req.query.limit || process.env.MAX_EVENTS_PER_CALL || 3);
  const events = await diagListBooksForSport(sport, { limit });
  if (!events.length && !["nfl", "mlb", "ncaaf"].includes(sport)) {
    return res.status(400).json({ ok: false, error: "unsupported_sport" });
  }
  res.json({
    ok: true,
    sport, limit,
    pulled: events.length,
    events: events.map(e => ({
      gameId: e.id, away: e.away, home: e.home, commence_time: e.commence_time,
      offers_count: e.books?.length || 0, books: e.books || []
    }))
  });
}));

// ---------- DEBUG: return one normalized snapshot (no Telegram) ----------
app.get("/api/debug/snapshot/:sport", guard(async (req, res) => {
  const sport = String(req.params.sport || "").toLowerCase();
  const limit = Number(req.query.limit || 1);
  const offset = Number(req.query.offset || 0);

  let fetcher = null;
  if (sport === "nfl") fetcher = getNFLH2HNormalized;
  else if (sport === "mlb") fetcher = getMLBH2HNormalized;
  else if (sport === "ncaaf") fetcher = getNCAAFH2HNormalized;
  else return res.status(400).json({ ok: false, error: "unsupported_sport" });

  const snaps = await fetcher({ limit, offset });
  const first = Array.isArray(snaps) && snaps.length ? snaps[0] : null;

  res.json({ ok: true, sport, limit, offset, has: Boolean(first), keys: first ? Object.keys(first) : [], snapshot: first });
}));

// ---------- DEBUG: run analyzer on one normalized snapshot ----------
app.get("/api/debug/analyze/:sport", guard(async (req, res) => {
  const sport = String(req.params.sport || "").toLowerCase();
  const limit = Number(req.query.limit || 1);
  const offset = Number(req.query.offset || 0);
  const bypass = req.query.bypass === "1";

  // pick fetcher
  let fetcher = null;
  if (sport === "nfl") fetcher = getNFLH2HNormalized;
  else if (sport === "mlb") fetcher = getMLBH2HNormalized;
  else if (sport === "ncaaf") fetcher = getNCAAFH2HNormalized;
  else return res.status(400).json({ ok: false, error: "unsupported_sport" });

  const snaps = await fetcher({ limit, offset });
  const snap = Array.isArray(snaps) && snaps.length ? snaps[0] : null;

  // TEMP debug overrides
  const forceSport = String(req.query.forceSport || "").toLowerCase();
  if (forceSport && snap) snap.sport = forceSport;
  const forceMarket = String(req.query.forceMarket || "");
  if (forceMarket && snap) snap.market = forceMarket;

  const analysis = snap ? analyzeMarket(snap, { bypassDedupe: bypass }) : null;

  res.json({
    ok: true, sport, limit, offset,
    has_snapshot: Boolean(snap),
    snapshot_keys: snap ? Object.keys(snap) : [],
    analysis_null: analysis === null,
    analysis,
  });
}));

// Mock scan (no credits)
app.get("/api/scan/mock", guard(async (req, res) => {
  const telegram = req.query.telegram === "true";
  const force = req.query.force === "1";
  const bypass = req.query.bypass === "1";

  const alert = {
    type: "forced",
    source: "splits",
    sport: "nfl",
    market: "NFL H2H (mock)",
    game_id: `mock-${Date.now()}`,
    game: { away: "Testers", home: "Mockers", start_time_utc: new Date(Date.now() + 60_000).toISOString() },
    sharp_side: { side: "home", team: "Mockers", confidence: "strong" },
    lines: { sharp_entry: -105, current_consensus: -105, direction: "flat", book: null },
    score: 3,
    signals: [
      { key: "split_gap", label: "Handle > Tickets by 20%", weight: 2 },
      { key: "hold", label: "Hold 2%", weight: 1 },
    ],
    render: { title: "SHARP ALERT – NFL Testers @ Mockers", emoji: "🔁", strength: "🟢 Strong", tags: ["SPLITS"] },
    meta: { generated_at: new Date().toISOString(), bypass },
  };

  let sent = 0;
  if (telegram && (BOOL(process.env.AUTO_TELEGRAM) || force)) {
    await sendTelegram(`${alert.render.emoji} ${alert.render.title}\n${alert.render.strength} • ${alert.market}`);
    sent = 1;
  }

  res.json({
    sport: "nfl", limit: 1, pulled: 1, analyzed: 1, sent_to_telegram: sent,
    timestamp_et: nowET(), planned_jobs: ["NFL H2H (mock)"], alerts: [alert]
  });
}));

// Main scan
app.get("/api/scan/:sport", guard(async (req, res) => {
  const sport = String(req.params.sport || "").toLowerCase();
  const limit = Number(req.query.limit || process.env.MAX_EVENTS_PER_CALL || 3);
  const offset = Number(req.query.offset || 0);
  const telegram = req.query.telegram === "true";
  const force = req.query.force === "1";
  const bypass = req.query.bypass === "1";

  const plannedJobs = [];
  const jobs = [];

  if (sport === "nfl") {
    if (BOOL(process.env.ENABLE_NFL_H2H)) { plannedJobs.push("NFL H2H"); jobs.push(getNFLH2HNormalized); }
  } else if (sport === "mlb") {
    if (BOOL(process.env.ENABLE_MLB_H2H)) { plannedJobs.push("MLB H2H"); jobs.push(getMLBH2HNormalized); }
  } else if (sport === "ncaaf") {
    if (BOOL(process.env.ENABLE_NCAAF_H2H)) { plannedJobs.push("NCAAF H2H"); jobs.push(getNCAAFH2HNormalized); }
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

  // fetch
  const snapshots = [];
  for (const job of jobs) {
    const got = await job({ limit, offset });
    if (Array.isArray(got) && got.length) snapshots.push(...got);
  }
  // snapshots already sliced by fetchers; keep a safety slice
  const sliced = snapshots.slice(0, limit);

  // analyze
  const analyzed = sliced.map(snap => analyzeMarket(snap, { bypassDedupe: bypass })).filter(Boolean);

  // telegram
  let sent = 0;
  if (telegram) {
    const auto = BOOL(process.env.AUTO_TELEGRAM);
    for (const a of analyzed) {
      const title = a?.render?.title || `${a?.sport?.toUpperCase() || ""} ${a?.game?.away} @ ${a?.game?.home}`;
      const strength = a?.render?.strength || "Signal";
      const tagStr = Array.isArray(a?.render?.tags) ? a.render.tags.join(", ") : "";
      const line = `${a?.lines?.sharp_entry ?? ""}`;
      const text =
        `${a?.render?.emoji || "📣"} ${title}\n` +
        `${strength} • ${a?.market}${tagStr ? ` • ${tagStr}` : ""}\n` +
        `${a?.sharp_side?.team || ""} @ ${line} • Book ${a?.lines?.book || "?"}`;
      if (auto || force) { await sendTelegram(text); sent += 1; }
    }
  }

  res.json({
    sport, limit, offset,
    pulled: sliced.length,
    analyzed: analyzed.length,
    sent_to_telegram: sent,
    timestamp_et: nowET(),
    planned_jobs: plannedJobs, alerts: analyzed
  });
}));

app.get("/", (_req, res) => res.type("text/plain").send("Odds Backend is live."));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Odds Backend listening on :${PORT}`));
