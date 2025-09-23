// src/index.js
import express from "express";
import cors from "cors";
import { FETCHERS } from "./fetchers.js";
import { analyzeMarket } from "../sharpEngine.js";

/* ----------------------------- Global crash guards ----------------------------- */
process.on("unhandledRejection", (err) => {
  console.error("UNHANDLED_REJECTION:", err?.stack || err);
});
process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT_EXCEPTION:", err?.stack || err);
});

/* -------------------------------- ENV / SAFETY -------------------------------- */
const PORT = process.env.PORT || 3000;

const HARD_KILL = flag("HARD_KILL", false);
const SCAN_ENABLED = flag("SCAN_ENABLED", false);
const AUTO_TELEGRAM = flag("AUTO_TELEGRAM", false);
const DIAG = flag("DIAG", true);

const MANUAL_MAX_JOBS = num("MANUAL_MAX_JOBS", 1);
const MAX_JOBS_PER_SPORT = num("MAX_JOBS_PER_SPORT", 1);
const MAX_EVENTS_PER_CALL = num("MAX_EVENTS_PER_CALL", 3);

const ENABLE_NFL_H2H = flag("ENABLE_NFL_H2H", true);

/* -------- provider/env bits we show in health & diagnostics ------------- */
const ODDS_API_ENABLED = flag("ODDS_API_ENABLED", false);
const ODDS_API_KEY = process.env.ODDS_API_KEY || "";
const ODDS_API_REGION = (process.env.ODDS_API_REGION || "us").toString();
const BOOKS_WHITELIST = (process.env.BOOKS_WHITELIST || "").toString();
const ALERT_BOOKS = (process.env.ALERT_BOOKS || "pinnacle").toString();

/* --------------------------------- APP BOOT --------------------------------- */
const app = express();
app.use(cors());
app.use(express.json());

/* -------------------------------- HARD KILL -------------------------------- */
if (HARD_KILL) {
  app.all("*", (_req, res) => {
    res.status(503).json({ error: "service_unavailable", note: "HARD_KILL=true" });
  });
} else {
  /* --------------------------------- Health --------------------------------- */
  app.get("/health", (_req, res) => {
    res.json({
      ok: true,
      env: {
        HARD_KILL,
        SCAN_ENABLED,
        AUTO_TELEGRAM,
        DIAG,
        MANUAL_MAX_JOBS,
        MAX_JOBS_PER_SPORT,
        MAX_EVENTS_PER_CALL,
        ENABLE_NFL_H2H,
        ODDS_API_ENABLED,
        ODDS_API_KEY_present: Boolean(ODDS_API_KEY),
        ODDS_API_REGION,
        BOOKS_WHITELIST,
        ALERT_BOOKS,
      },
      ts: new Date().toISOString(),
    });
  });

  /* --------------------------- Provider diagnostics -------------------------- */
  app.get(["/diag/provider", "/api/diag/provider"], async (_req, res) => {
    try {
      if (!ODDS_API_ENABLED) {
        return res.json({
          ok: true,
          provider_enabled: false,
          reason: "ODDS_API_ENABLED=false",
          hint: "Set ODDS_API_ENABLED=true in Render → Environment, then redeploy.",
        });
      }
      if (!ODDS_API_KEY) {
        return res.status(400).json({
          ok: false,
          error: "missing_odds_api_key",
          hint: "Add ODDS_API_KEY in Render → Environment and redeploy.",
        });
      }
      const url = `https://api.the-odds-api.com/v4/sports?apiKey=${encodeURIComponent(ODDS_API_KEY)}`;
      const r = await fetch(url, { method: "GET" });
      const text = await r.text();
      let body; try { body = JSON.parse(text); } catch { body = text; }
      return res.status(r.ok ? 200 : 400).json({
        ok: r.ok,
        status: r.status,
        provider_enabled: ODDS_API_ENABLED,
        region: ODDS_API_REGION,
        books_whitelist: BOOKS_WHITELIST,
        alert_books: ALERT_BOOKS,
        response_sample: Array.isArray(body) ? body.slice(0, 3) : body,
      });
    } catch (e) {
      return res.status(500).json({ ok: false, error: "provider_diag_failed", message: e?.message || String(e) });
    }
  });

  /* ---------------------- Scan diagnostics (books per game) ------------------ */
  // GET /api/diag/scan/nfl?limit=3
  app.get("/api/diag/scan/:sport", async (req, res) => {
    try {
      const sport = String(req.params.sport || "").toLowerCase();
      const limit = clampInt(req.query.limit, 3, 1, 20);
      if (sport !== "nfl") return res.status(400).json({ ok: false, error: "unsupported_sport" });

      const out = [];
      const snaps = await FETCHERS.fetchNFLH2H({ limit });
      for (const s of snaps) {
        const books = Array.from(
          new Set((s?.offers || []).map(o => (o.book || o.bookmaker || "").toLowerCase()).filter(Boolean))
        );
        out.push({
          gameId: s.gameId,
          away: s.away,
          home: s.home,
          commence_time: s.commence_time,
          offers_count: s?.offers?.length || 0,
          books,
        });
      }
      return res.json({ ok: true, pulled: snaps.length, events: out });
    } catch (e) {
      return res.status(500).json({ ok: false, error: "scan_diag_failed", message: e?.message || String(e) });
    }
  });

  /* ---------------------- Zero-credit Telegram test ping --------------------- */
  // GET /api/telegram/test?text=Hello&force=1
  app.get("/api/telegram/test", async (req, res) => {
    try {
      const textRaw = (req.query.text ?? "🚨 TEST — Odds Backend Telegram wired 🔧 (safe mode)").toString();
      const text = textRaw.slice(0, 3600);
      const force = toBool(req.query.force, false);

      if (!AUTO_TELEGRAM && !force) {
        return res.status(400).json({
          ok: false,
          error: "auto_telegram_disabled",
          note: "AUTO_TELEGRAM=false. Add &force=1 to override for this test.",
        });
      }

      const send = await sendTelegram(text);
      return res.status(send.ok ? 200 : 400).json(send);
    } catch (e) {
      return res.status(500).json({ ok: false, error: "telegram_test_failed", message: e?.message || String(e) });
    }
  });

  /* --------------------------- Mock scan → Telegram -------------------------- */
  // MUST be above /api/scan/:sport
  // GET /api/scan/mock?telegram=true&force=1
  app.get("/api/scan/mock", async (req, res) => {
    try {
      const wantTelegram = toBool(req.query.telegram, false);
      const force = toBool(req.query.force, false);

      const snapshot = {
        sport: "nfl",
        market: "NFL H2H",
        gameId: `mock-${Date.now()}`,
        home: "Mockers",
        away: "Testers",
        commence_time: new Date(Date.now() + 3 * 3600e3).toISOString(), // +3h
        tickets: 40, handle: 60, hold: 0.02, side: "home", line: -105,
        offers: [
          { book: "pinnacle",   prices: { home: { american: 120 }, away: { american: -130 } } },
          { book: "draftkings", prices: { home: { american: 105 }, away: { american: -115 } } },
          { book: "betmgm",     prices: { home: { american: 105 }, away: { american: -115 } } },
        ],
      };

      let alert = null;
      try { alert = analyzeMarket(snapshot); } catch (e) { console.error("analyze_mock_error:", e?.stack || e); }

      let sent = 0;
      const sendErrs = [];
      if (alert && wantTelegram && (force || AUTO_TELEGRAM)) {
        try {
          const txt = formatAlertForTelegram(alert);
          const result = await sendTelegram(txt);
          if (result.ok) sent = 1; else sendErrs.push(result);
        } catch (e) { sendErrs.push({ stage: "telegram_send", message: e?.message || String(e) }); }
      }

      const response = summary({
        sport: "nfl",
        limit: 1,
        pulled: 1,
        analyzed: alert ? 1 : 0,
        sent: sent,
        planned_jobs: ["NFL H2H (mock)"],
        alerts: alert ? [alert] : [],
      });
      if (DIAG && sendErrs.length) response.errors = sendErrs;
      return res.status(200).json(response);
    } catch (e) {
      return res.status(500).json({ ok: false, error: "mock_scan_failed", message: e?.message || String(e) });
    }
  });

  /* -------------------------------- Manual scan ----------------------------- */
  // GET /api/scan/nfl?limit=3&telegram=true&force=1
  app.get("/api/scan/:sport", async (req, res) => {
    try {
      const sport = String(req.params.sport || "").toLowerCase();
      const limit = clampInt(req.query.limit, 3, 1, 50);
      const wantTelegram = toBool(req.query.telegram, false);
      const force = toBool(req.query.force, false);   // NEW: allow force send
      const dryrun = toBool(req.query.dryrun, false);

      if (sport !== "nfl") {
        return res.status(400).json({ error: "unsupported_sport", sport });
      }

      const planned_jobs = [];
      if (sport === "nfl" && ENABLE_NFL_H2H) planned_jobs.push("NFL H2H");

      if (planned_jobs.length === 0) {
        return res.json(summary({ sport, limit, pulled: 0, analyzed: 0, sent: 0, planned_jobs }));
      }
      if (dryrun) {
        return res.json(summary({ sport, limit, pulled: 0, analyzed: 0, sent: 0, planned_jobs }));
      }

      const jobsToRun = planned_jobs.slice(0, Math.min(MANUAL_MAX_JOBS, MAX_JOBS_PER_SPORT));
      let pulled = 0, analyzed = 0, sent = 0;
      const alerts = [], errors = [], sendErrs = [];

      for (const job of jobsToRun) {
        if (job !== "NFL H2H") continue;

        let snaps = [];
        try {
          snaps = await FETCHERS.fetchNFLH2H({ limit });
        } catch (e) {
          errors.push({ stage: "fetchNFLH2H", message: e?.message || String(e) });
          snaps = [];
        }
        pulled += snaps.length;

        for (const snap of snaps) {
          try {
            const alert = analyzeMarket(snap);
            if (!alert) continue;
            analyzed++;
            alerts.push(alert);

            if (wantTelegram && (AUTO_TELEGRAM || force)) { // NEW: force override
              try {
                const txt = formatAlertForTelegram(alert);
                const result = await sendTelegram(txt);
                if (result.ok) sent++;
                else sendErrs.push(result);
              } catch (e) {
                sendErrs.push({ stage: "telegram_send", message: e?.message || String(e) });
              }
            }
          } catch (e) {
            errors.push({ stage: "analyzeMarket", message: e?.message || String(e) });
          }
        }
      }

      const body = summary({ sport, limit, pulled, analyzed, sent, planned_jobs, alerts });
      if (DIAG && (errors.length || sendErrs.length)) body.errors = [...errors, ...sendErrs];
      return res.json(body);
    } catch (e) {
      console.error("scan_error:", e?.stack || e);
      return res.status(500).json({ error: "scan_failed", message: e?.message || String(e) });
    }
  });
}

/* ---------------------------------- SERVER --------------------------------- */
app.listen(PORT, () => {
  console.log(`odds-backend listening on :${PORT}`);
});

/* ------------------------------ Telegram utils ----------------------------- */
async function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN || "";
  const chatId = process.env.TELEGRAM_CHAT_ID || "";

  if (!token || !chatId) {
    return { ok: false, error: "missing_telegram_env", need: ["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"] };
  }

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const payload = { chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true };

  try {
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    const j = await r.json().catch(() => ({}));
    return { ok: j?.ok === true, status: r.status, body: j };
  } catch (e) {
    return { ok: false, error: "telegram_request_failed", message: e?.message || String(e) };
  }
}

function formatAlertForTelegram(a) {
  const title = a?.render?.title || "SHARP ALERT";
  const strength = a?.render?.strength || "";
  const sideTeam = a?.sharp_side?.team ? `Side: <b>${a.sharp_side.team}</b>` : "";
  const price = a?.lines?.sharp_entry != null ? ` @ <b>${fmtAm(a.lines.sharp_entry)}</b>` : "";
  const book = a?.lines?.book ? `• Book: ${a.lines.book}` : "";
  const src = a?.source ? `• Source: ${a.source.toUpperCase()}` : "";

  // enrich for EV vs OUTLIER
  let extra = "";
  if (a?.source === "ev") {
    const ev = a?.signals?.find((s) => s.key === "ev_pct");
    extra = ev ? `• ${ev.label}` : "";
  } else if (a?.source === "outlier") {
    const delta = a?.signals?.find((s) => s.key === "delta_cents");
    const med = a?.signals?.find((s) => s.key === "median_ref");
    extra = [delta?.label, med?.label].filter(Boolean).join(" • ");
  }

  return [
    `🚨 <b>${title}</b>`,
    `${strength}${price}`,
    sideTeam,
    src,
    book,
    extra,
  ].filter(Boolean).join("\n");
}

/* ----------------------------------- Helpers -------------------------------- */
function flag(k, def = false) {
  const v = process.env[k];
  if (v == null) return def;
  const s = String(v).toLowerCase();
  if (["1", "true", "y", "yes"].includes(s)) return true;
  if (["0", "false", "n", "no"].includes(s)) return false;
  return def;
}
function num(k, def = 0) { const n = Number(process.env[k]); return Number.isFinite(n) ? n : def; }
function toBool(v, def = false) {
  if (v == null) return def;
  const s = String(v).toLowerCase();
  if (["1", "true", "y", "yes"].includes(s)) return true;
  if (["0", "false", "n", "no"].includes(s)) return false;
  return def;
}
function clampInt(v, def, min, max) {
  const n = Number(v); if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, Math.floor(n)));
}
function summary({ sport, limit, pulled, analyzed, sent, planned_jobs, alerts = [] }) {
  const out = {
    sport,
    limit: limit ?? 0,
    pulled: pulled ?? 0,
    analyzed: analyzed ?? 0,
    sent_to_telegram: sent ?? 0,
    timestamp_et: new Date().toLocaleString("en-US", { timeZone: "America/New_York", hour12: true }),
    planned_jobs,
  };
  if (DIAG) out.alerts = alerts;
  return out;
}
function fmtAm(a) { return a >= 0 ? `+${a}` : `${a}`; }
