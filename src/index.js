import "dotenv/config";
import express from "express";
import cors from "cors";
import cron from "node-cron";
import { FETCHERS, isOn } from "./fetchers.js";
import { analyzeMarket } from "../sharpEngine.js";
import { sendTelegramMessage } from "../telegram.js";
import { getPropsNormalized } from "../odds_service.js";

const app = express();
app.use(cors());

/* -------------------- Small utils -------------------- */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowET = () =>
  new Date().toLocaleString("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

/* -------------------- Env knobs -------------------- */
const SCAN_ENABLED = String(process.env.SCAN_ENABLED ?? "true").toLowerCase() === "true";
const RATE_LIMIT_MS = Number(process.env.RATE_LIMIT_MS || 600);               // delay between *market* requests
const RETRY_429_MAX = Number(process.env.RETRY_429_MAX || 2);                 // retries on 429
const RETRY_BASE_MS = Number(process.env.RETRY_BASE_MS || 500);               // base backoff
const CRON_PAUSE_BETWEEN_SPORTS_MS = Number(process.env.CRON_PAUSE_BETWEEN_SPORTS_MS || 1200);
const CRON_MIN = Number(process.env.SCAN_INTERVAL_MIN || 5);                  // cron every N minutes
const DEFAULT_LIMIT = 15;

/* -------------------- Locks to prevent overlap -------------------- */
const sportLocks = new Map(); // sport -> boolean
let cronRunning = false;

async function withSportLock(sport, fn) {
  if (sportLocks.get(sport)) {
    console.warn(`🔒 Skip scan for ${sport} (already running)`);
    return null;
  }
  sportLocks.set(sport, true);
  try { return await fn(); }
  finally { sportLocks.set(sport, false); }
}

/* -------------------- Provider-friendly fetch -------------------- */
async function fetchWithRetry(label, fn, args = {}) {
  let attempt = 0;
  const jitter = () => Math.floor(Math.random() * 120);

  while (true) {
    try {
      const out = await fn(args);
      return Array.isArray(out) ? out : [];
    } catch (err) {
      const msg = String(err?.message || err);

      if (msg.includes("INVALID_MARKET") || msg.includes("Markets not supported") || msg.includes("status=422")) {
        console.warn(`⚠️  Skipping unsupported market: ${label}`);
        return [];
      }
      if (msg.includes("429") || msg.toLowerCase().includes("too many requests")) {
        if (attempt >= RETRY_429_MAX) {
          console.warn(`⏳ 429 on ${label} — max retries hit, skipping`);
          return [];
        }
        const wait = RETRY_BASE_MS * Math.pow(2, attempt) + jitter();
        console.warn(`⏳ 429 on ${label} — retry in ${wait}ms (attempt ${attempt + 1}/${RETRY_429_MAX})`);
        await sleep(wait);
        attempt++;
        continue;
      }

      console.error(`❌ Fetch failed for ${label}:`, err);
      return [];
    }
  }
}

async function runSequential(jobs /* [label, fn, args][] */) {
  const out = [];
  for (const [label, fn, args] of jobs) {
    const data = await fetchWithRetry(label, fn, args);
    out.push(data);
    await sleep(RATE_LIMIT_MS);
  }
  return out.flat();
}

/* -------------------- Max-info Telegram formatting -------------------- */
function formatOneAlert(a) {
  const t = a?.type === "realert_plus" ? "🟢 Improved"
          : a?.type === "realert"      ? "🔁 Re-entry"
          : "🚨 New";
  const strength = a?.render?.strength || (a?.score >= 5 ? "🟢 Strong" : "🟡 Lean");
  const start = a?.game?.start_time_utc
    ? new Date(a.game.start_time_utc).toLocaleString("en-US", {
        timeZone: "America/New_York",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      }) + " ET"
    : "TBD";
  const market = (a?.market || "").toUpperCase();
  const sideTeam = a?.sharp_side?.team || "Split";
  const entry = a?.lines?.sharp_entry ?? a?.lines?.current_consensus ?? "—";
  const current = a?.lines?.current_consensus ?? "—";
  const score = Number(a?.score ?? 0);

  let msg = `${t} *${a?.render?.title || `${(a?.sport || "").toUpperCase()} ${a?.game?.away} @ ${a?.game?.home}`}*`;
  msg += `\n\n📅 ${start}`;
  msg += `\n⚔️ ${a?.game?.away} @ ${a?.game?.home}`;
  msg += `\n🎯 Market: ${market}`;
  msg += `\n🧭 Sharp Side: *${sideTeam}*`;
  msg += `\n📊 Score: ${score} (${strength})`;
  if (Array.isArray(a?.signals) && a.signals.length > 0) {
    const labels = a.signals.map(s => s.label || s.type).filter(Boolean).join(", ");
    if (labels) msg += `\n🏷️ Signals: ${labels}`;
  }
  msg += `\n\n📈 Entry: ${entry}`;
  msg += `\n📉 Current: ${current}`;
  if (a?.meta?.profile) msg += `\n🧪 Profile: ${a.meta.profile}`;
  return msg;
}

function formatMaxInfoBatch(alerts, { mode = "AUTO", auto = false } = {}) {
  const timestamp = nowET();
  const header = `🔔 *GoSignals ${auto ? "Auto" : "Manual"} Batch*  \n⏰ ${timestamp} ET  \nTotal: ${alerts.length}  \nMode: ${mode}`;
  const body = alerts.map(formatOneAlert).join("\n\n────────────\n\n");
  return `${header}\n\n────────────\n\n${body}`;
}

async function sendMaxInfoTelegram(analyzed, autoMode = false) {
  if (!Array.isArray(analyzed) || analyzed.length === 0) return;
  const text = formatMaxInfoBatch(analyzed, {
    mode: (process.env.SHARP_PROFILE || "sharpest").toUpperCase(),
    auto: Boolean(autoMode),
  });
  await sendTelegramMessage(text);
  console.log(`📨 Sent ${analyzed.length} alerts @ ${nowET()} ET`);
}

/* -------------------- Build jobs per sport -------------------- */
function buildJobsForSport(sport) {
  const jobs = [];
  if (sport === "mlb") {
    if (isOn("ENABLE_MLB_H2H", true))         jobs.push(["MLB H2H",         FETCHERS.mlb.h2h,         { minHold: null }]);
    if (isOn("ENABLE_MLB_SPREADS", true))     jobs.push(["MLB Spreads",     FETCHERS.mlb.spreads,     { minHold: null }]);
    if (isOn("ENABLE_MLB_TOTALS", true))      jobs.push(["MLB Totals",      FETCHERS.mlb.totals,      { minHold: null }]);
    if (isOn("ENABLE_MLB_F5_H2H", true))      jobs.push(["MLB F5 H2H",      FETCHERS.mlb.f5_h2h,      { minHold: null }]);
    if (isOn("ENABLE_MLB_F5_TOTALS", true))   jobs.push(["MLB F5 Totals",   FETCHERS.mlb.f5_totals,   { minHold: null }]);
    if (isOn("ENABLE_MLB_TEAM_TOTALS", true)) jobs.push(["MLB Team Totals", FETCHERS.mlb.team_totals, { minHold: null }]);
    if (isOn("ENABLE_MLB_ALT", true))         jobs.push(["MLB Alt",         FETCHERS.mlb.alt,         { minHold: null }]);
  }
  if (sport === "nfl") {
    if (isOn("ENABLE_NFL_H2H", true))     jobs.push(["NFL H2H",     FETCHERS.nfl.h2h,     { minHold: null }]);
    if (isOn("ENABLE_NFL_SPREADS", true)) jobs.push(["NFL Spreads", FETCHERS.nfl.spreads, { minHold: null }]);
    if (isOn("ENABLE_NFL_TOTALS", true))  jobs.push(["NFL Totals",  FETCHERS.nfl.totals,  { minHold: null }]);
    if (isOn("ENABLE_NFL_H1", true)) {
      if (FETCHERS.nfl.h1_spreads) jobs.push(["NFL 1H Spreads", FETCHERS.nfl.h1_spreads, { minHold: null }]);
      if (FETCHERS.nfl.h1_totals)  jobs.push(["NFL 1H Totals",  FETCHERS.nfl.h1_totals,  { minHold: null }]);
      if (FETCHERS.nfl.h1_h2h)     jobs.push(["NFL 1H H2H",     FETCHERS.nfl.h1_h2h,     { minHold: null }]);
    }
  }
  if (sport === "nba") {
    if (isOn("ENABLE_NBA_H2H", true))     jobs.push(["NBA H2H",     FETCHERS.nba.h2h,     { minHold: null }]);
    if (isOn("ENABLE_NBA_SPREADS", true)) jobs.push(["NBA Spreads", FETCHERS.nba.spreads, { minHold: null }]);
    if (isOn("ENABLE_NBA_TOTALS", true))  jobs.push(["NBA Totals",  FETCHERS.nba.totals,  { minHold: null }]);
  }
  if (sport === "ncaaf") {
    if (isOn("ENABLE_NCAAF_H2H", true))     jobs.push(["NCAAF H2H",     FETCHERS.ncaaf.h2h,     { minHold: null }]);
    if (isOn("ENABLE_NCAAF_SPREADS", true)) jobs.push(["NCAAF Spreads", FETCHERS.ncaaf.spreads, { minHold: null }]);
    if (isOn("ENABLE_NCAAF_TOTALS", true))  jobs.push(["NCAAF Totals",  FETCHERS.ncaaf.totals,  { minHold: null }]);
  }
  if (sport === "ncaab") {
    if (isOn("ENABLE_NCAAB_H2H", true))     jobs.push(["NCAAB H2H",     FETCHERS.ncaab.h2h,     { minHold: null }]);
    if (isOn("ENABLE_NCAAB_SPREADS", true)) jobs.push(["NCAAB Spreads", FETCHERS.ncaab.spreads, { minHold: null }]);
    if (isOn("ENABLE_NCAAB_TOTALS", true))  jobs.push(["NCAAB Totals",  FETCHERS.ncaab.totals,  { minHold: null }]);
  }
  return jobs;
}

/* -------------------- Core scan (internal) -------------------- */
async function scanSportInternal(sport, { limit = DEFAULT_LIMIT, telegram = false } = {}) {
  if (!FETCHERS[sport]) return { error: "unsupported_sport", sport };

  return await withSportLock(sport, async () => {
    const jobs = buildJobsForSport(sport);
    const flattened = await runSequential(jobs);
    const limited = flattened.slice(0, limit);
    const analyzed = limited.map((a) => analyzeMarket(a)).filter(Boolean);

    if (telegram) await sendMaxInfoTelegram(analyzed, true);

    return {
      sport,
      limit,
      pulled: flattened.length,
      analyzed: analyzed.length,
      sent_to_telegram: telegram ? analyzed.length : 0,
      timestamp_et: nowET(),
    };
  });
}

/* -------------------- Health -------------------- */
app.get("/health", (_req, res) => res.json({ ok: true }));

/* -------------------- Manual scan API (kept) -------------------- */
app.get("/api/scan/:sport", async (req, res) => {
  const sport = String(req.params.sport || "").toLowerCase();
  const limit = Math.min(15, Math.max(1, Number(req.query.limit ?? DEFAULT_LIMIT)));
  const wantsTelegram = String(req.query.telegram || "").toLowerCase() === "true";

  const result = await scanSportInternal(sport, { limit, telegram: wantsTelegram });
  if (!result) return res.json({ sport, skipped: true, reason: "busy" });
  res.json(result);
});

/* -------------------- MLB F5 + Full routes (kept) -------------------- */
app.get("/api/mlb/f5_scan", async (req, res) => {
  const out = await scanSportInternal("mlb", { limit: Number(req.query.limit ?? 15), telegram: String(req.query.telegram || "").toLowerCase() === "true" });
  res.json(out);
});
app.get("/api/mlb/game_scan", async (req, res) => {
  const out = await scanSportInternal("mlb", { limit: Number(req.query.limit ?? 15), telegram: String(req.query.telegram || "").toLowerCase() === "true" });
  res.json(out);
});

/* -------------------- Generic odds JSON (after scan routes) -------------------- */
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

    const data = await fetchWithRetry(`${sport} ${market}`, FETCHERS[sport][market], { minHold: null });
    if (raw) return res.json(data);

    const analyzed = Array.isArray(data) ? data.map(a => analyzeMarket(a)).filter(Boolean) : [];
    res.json(analyzed);
  } catch (err) {
    console.error("oddsHandler error:", err);
    res.status(500).json({ error: String(err) });
  }
});

/* -------------------- Auto Scanning (INTERNAL + kill-switch) -------------------- */
if (SCAN_ENABLED) {
  cron.schedule(`*/${CRON_MIN} * * * *`, async () => {
    if (cronRunning) {
      console.warn("⏸️  Skipping cron tick (previous still running)");
      return;
    }
    cronRunning = true;
    try {
      const hourET = new Date().toLocaleString("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false });
      const hour = Number(hourET);
      if (hour < Number(process.env.SCAN_START_HOUR || 6) || hour >= Number(process.env.SCAN_STOP_HOUR || 24)) return;

      const sports = (process.env.SCAN_SPORTS || "mlb").split(",").map(s => s.trim().toLowerCase());
      for (const sport of sports) {
        try {
          const res = await scanSportInternal(sport, { limit: DEFAULT_LIMIT, telegram: true });
          console.log(`🤖 Auto-scan ${sport}: pulled=${res?.pulled ?? 0} analyzed=${res?.analyzed ?? 0} @ ${res?.timestamp_et ?? nowET()} ET`);
        } catch (err) {
          console.error(`❌ Auto-scan failed for ${sport}:`, err);
        }
        await sleep(CRON_PAUSE_BETWEEN_SPORTS_MS);
      }
    } finally {
      cronRunning = false;
    }
  });
} else {
  console.warn("⏹️  SCAN_ENABLED=false → cron is disabled");
}

/* -------------------- Start Server -------------------- */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
