// src/index.js
import express from "express";
import cors from "cors";
import { FETCHERS } from "./fetchers.js";
import { analyzeMarket } from "../sharpEngine.js";

/* ------------------------------ ENV / SAFETY ------------------------------ */
const PORT = process.env.PORT || 3000;

const HARD_KILL = flag("HARD_KILL", false);
const SCAN_ENABLED = flag("SCAN_ENABLED", false);        // cron/auto (we're using manual scans)
const AUTO_TELEGRAM = flag("AUTO_TELEGRAM", false);
const DIAG = flag("DIAG", true);

const MANUAL_MAX_JOBS = num("MANUAL_MAX_JOBS", 1);
const MAX_JOBS_PER_SPORT = num("MAX_JOBS_PER_SPORT", 1);
const MAX_EVENTS_PER_CALL = num("MAX_EVENTS_PER_CALL", 3);

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

  /* ------------------------------ Manual scan ------------------------------ */
  // Supported: /api/scan/nfl?limit=5&telegram=false&dryrun=true
  app.get("/api/scan/:sport", async (req, res) => {
    try {
      const sport = String(req.params.sport || "").toLowerCase();
      const limit = clampInt(req.query.limit, 5, 1, 50);
      const wantTelegram = toBool(req.query.telegram, false);
      const dryrun = toBool(req.query.dryrun, false);

      // currently we only support nfl (expand later)
      if (sport !== "nfl") {
        return res.status(400).json({ error: "unsupported_sport", sport });
      }

      // plan jobs for this sport with current toggles
      const planned_jobs = [];
      if (sport === "nfl" && ENABLE_NFL_H2H) planned_jobs.push("NFL H2H");

      if (planned_jobs.length === 0) {
        return res.json(summary({
          sport, limit, pulled: 0, analyzed: 0, sent: 0, planned_jobs
        }));
      }

      if (dryrun) {
        // Just show what we'd run — no provider calls
        return res.json(summary({
          sport, limit, pulled: 0, analyzed: 0, sent: 0, planned_jobs
        }));
      }

      // execute with strict safety clamps
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
            }
          }
        }
      }

      // No auto sends in safety mode – just report
      if (wantTelegram && AUTO_TELEGRAM) {
        // (intentionally no-op right now; you disabled AUTO_TELEGRAM)
      }

      const body = summary({ sport, limit, pulled, analyzed, sent, planned_jobs, alerts });
      return res.json(body);
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
    limit,
    pulled,
    analyzed,
    sent_to_telegram: sent,
    timestamp_et: new Date().toLocaleString("en-US", { timeZone: "America/New_York", hour12: true }),
    planned_jobs,
  };
  // Include alerts only when DIAG enabled to keep payload small
  if (DIAG) out.alerts = alerts;
  return out;
}
