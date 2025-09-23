// src/index.js
import express from "express";
import cors from "cors";
import { FETCHERS } from "./fetchers.js";
import { analyzeMarket } from "../sharpEngine.js";

/* ------------------------------ ENV / SAFETY ------------------------------ */
const PORT = process.env.PORT || 3000;

const HARD_KILL = flag("HARD_KILL", false);
const SCAN_ENABLED = flag("SCAN_ENABLED", false);        // cron/auto (unused here)
const AUTO_TELEGRAM = flag("AUTO_TELEGRAM", false);      // default OFF; test & mock can force
const DIAG = flag("DIAG", true);

const MANUAL_MAX_JOBS = num("MANUAL_MAX_JOBS", 1);
const MAX_JOBS_PER_SPORT = num("MAX_JOBS_PER_SPORT", 1);
const MAX_EVENTS_PER_CALL = num("MAX_EVENTS_PER_CALL", 3); // fetchers honor this

const ENABLE_NFL_H2H = flag("ENABLE_NFL_H2H", true);

/* ------------------------------ APP BOOTSTRAP ----------------------------- */
const app = express();
app.use(cors());
app.use(express.json());

/* ------------------------------ HARD KILL GATE ---------------------------- */
if (HARD_KILL) {
  app.all("*", (_req, res) => {
    res.status(503).json({ error: "service_unavailable", note: "HARD_KILL=true" });
  });
} else {
  /* --------------------------------- Health -------------------------------- */
  app.get("/health", (_req, res) => {
    res.json({
      ok: true,
      env: {
        HARD_KILL,
        SCAN_ENABLED,
        AUTO_TELEGRAM,
        MANUAL_MAX_JOBS,
        MAX_JOBS_PER_SPORT,
        MAX_EVENTS_PER_CALL,
        ENABLE_NFL_H2H,
      },
      ts: new Date().toISOString(),
    });
  });

  /* ---------------------- Zero-credit Telegram test ping -------------------- */
  // GET /api/telegram/test?text=Hello&force=1
  app.get("/api/telegram/test", async (req, res) => {
    try {
      const textRaw =
        (req.query.text ?? "🚨 TEST — Odds Backend Telegram wired 🔧 (safe mode)").toString();
      const text = textRaw.slice(0, 3600); // Telegram limit safety
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
      return res
        .status(500)
        .json({ ok: false, error: "telegram_test_failed", message: e?.message || String(e) });
    }
  });

  /* -------------------------- Mock scan → Telegram -------------------------- */
  // IMPORTANT: this route is above /api/scan/:sport so it doesn't get captured as sport=mock
  // GET /api/scan/mock?telegram=true&force=1
  app.get("/api/scan/mock", async (req, res) => {
    try {
      const wantTelegram = toBool(req.query.telegram, false);
      const force = toBool(req.query.force, false);

      // Synthetic snapshot that guarantees an EV alert (no provider calls, zero credits)
      const snapshot = {
        sport: "nfl",
        market: "NFL H2H",
        gameId: `mock-${Date.now()}`,
        home: "Mockers",
        away: "Testers",
        commence_time: new Date(Date.now() + 3 * 3600e3).toISOString(), // +3h

        // SPLITS fields (kept for completeness; EV path will fire regardless)
        tickets: 40,
        handle: 60,
        hold: 0.02,
        side: "home",
        line: -105,

        // EV path: 3-book market with a clear edge at Pinnacle (default ALERT_BOOKS)
        offers: [
          { book: "pinnacle",    prices: { home: { american: 120 }, away: { american: -130 } } },
          { book: "draftkings",  prices: { home: { american: 105 }, away: { american: -115 } } },
          { book: "betmgm",      prices: { home: { american: 105 }, away: { american: -115 } } },
        ],
      };

      const alert = analyzeMarket(snapshot);
      let sent = 0;

      if (alert && wantTelegram && (force || AUTO_TELEGRAM)) {
        const txt = formatAlertForTelegram(alert);
        const result = await sendTelegram(txt);
        if (result.ok) sent = 1;
      }

      return res.status(200).json(
        summary({
          sport: "nfl",
          limit: 1,
          pulled: 1,
          analyzed: alert ? 1 : 0,
          sent: sent,
          planned_jobs: ["NFL H2H (mock)"],
          alerts: alert ? [alert] : [],
        })
      );
    } catch (e) {
      return res
        .status(500)
        .json({ ok: false, error: "mock_scan_failed", message: e?.message || String(e) });
    }
  });

  /* ------------------------------ Manual scan ------------------------------ */
  // GET /api/scan/nfl?limit=5&telegram=false&dryrun=true
  // With ODDS_API_ENABLED=false (in fetchers), this does NOT hit the provider.
  app.get("/api/scan/:sport", async (req, res) => {
    try {
      const sport = String(req.params.sport || "").toLowerCase();
      const limit = clampInt(req.query.limit, 5, 1, 50);
      const wantTelegram = toBool(req.query.telegram, false);
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
      let pulled = 0;
      let analyzed = 0;
      let sent = 0;
      const alerts = [];

      for (const job of jobsToRun) {
        if (job === "NFL H2H") {
          const snaps = await FETCHERS.fetchNFLH2H({ limit });
          pulled += snaps.length;

          for (const snap of snaps) {
            const alert = analyzeMarket(snap);
            if (alert) {
              analyzed++;
              alerts.push(alert);
              if (wantTelegram && AUTO_TELEGRAM) {
                const txt = formatAlertForTelegram(alert);
                const result = await sendTelegram(txt);
                if (result.ok) sent++;
              }
            }
          }
        }
      }

      return res.json(
        summary({ sport, limit, pulled, analyzed, sent, planned_jobs, alerts })
      );
    } catch (e) {
      console.error("scan_error:", e?.stack || e);
      return res.status(500).json({ error: "scan_failed", message: e?.message || String(e) });
    }
  });
}

/* --------------------------------- SERVER --------------------------------- */
app.listen(PORT, () => {
  console.log(`odds-backend listening on :${PORT}`);
});

/* ------------------------------ Telegram util ----------------------------- */
async function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN || "";
  const chatId = process.env.TELEGRAM_CHAT_ID || "";

  if (!token || !chatId) {
    return {
      ok: false,
      error: "missing_telegram_env",
      need: ["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"],
    };
  }

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const payload = {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  };

  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const j = await r.json().catch(() => ({}));
    return { ok: j?.ok === true, status: r.status, body: j };
  } catch (e) {
    return { ok: false, error: "telegram_request_failed", message: e?.message || String(e) };
  }
}

function formatAlertForTelegram(a) {
  const title = a?.render?.title || "SHARP ALERT";
  const strength = a?.render?.strength || "";
  const side = a?.sharp_side?.team ? `Side: <b>${a.sharp_side.team}</b>` : "";
  const price =
    a?.lines?.sharp_entry != null ? ` @ <b>${a.lines.sharp_entry}</b>` : "";
  const src = a?.source ? `• Source: ${a.source.toUpperCase()}` : "";
  const ev = a?.signals?.find((s) => s.key === "ev_pct");
  const evLine = ev ? `• EV: ${ev.label}` : "";
  return [`🚨 <b>${title}</b>`, `${strength}${price}`, side, src, evLine]
    .filter(Boolean)
    .join("\n");
}

/* --------------------------------- Helpers -------------------------------- */
function flag(k, def = false) {
  const v = process.env[k];
  if (v == null) return def;
  const s = String(v).toLowerCase();
  if (["1", "true", "y", "yes"].includes(s)) return true;
  if (["0", "false", "n", "no"].includes(s)) return false;
  return def;
}
function num(k, def = 0) {
  const n = Number(process.env[k]);
  return Number.isFinite(n) ? n : def;
}
function toBool(v, def = false) {
  if (v == null) return def;
  const s = String(v).toLowerCase();
  if (["1", "true", "y", "yes"].includes(s)) return true;
  if (["0", "false", "n", "no"].includes(s)) return false;
  return def;
}
function clampInt(v, def, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, Math.floor(n)));
}
function summary({ sport, limit, pulled, analyzed, sent, planned_jobs, alerts = [] }) {
  const out = {
    sport,
    limit: limit ?? 0,
    pulled: pulled ?? 0,
    analyzed: analyzed ?? 0,
    sent_to_telegram: sent ?? 0,
    timestamp_et: new Date().toLocaleString("en-US", {
      timeZone: "America/New_York",
      hour12: true,
    }),
    planned_jobs,
  };
  if (DIAG) out.alerts = alerts;
  return out;
}
