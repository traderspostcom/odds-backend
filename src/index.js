// src/index.js
// Main entrypoint for odds-backend service

import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { analyzeMarket } from "../sharpEngine.js"; // ✅ correct path

dotenv.config();

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json());

/* --------------------------- Basic Health Check -------------------------- */
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    env: {
      HARD_KILL: process.env.HARD_KILL || false,
      SCAN_ENABLED: process.env.SCAN_ENABLED || false,
      AUTO_TELEGRAM: process.env.AUTO_TELEGRAM || false,
      DIAG: process.env.DIAG || false,
    },
    ts: new Date().toISOString(),
  });
});

/* ----------------------------- Scan Endpoint ----------------------------- */
app.get("/api/scan/:sport", async (req, res) => {
  const { sport } = req.params;
  const { limit = 1, offset = 0, telegram = "false", force = "0" } = req.query;

  try {
    const alerts = await analyzeMarket({
      sport,
      limit: Number(limit),
      offset: Number(offset),
      telegram: telegram === "true",
      force: force === "1",
    });

    res.json({
      sport,
      limit: Number(limit),
      pulled: alerts.length,
      analyzed: alerts.filter(a => a.analyzed).length,
      sent_to_telegram: alerts.filter(a => a.sent_to_telegram).length,
      timestamp_et: new Date().toLocaleString("en-US", {
        timeZone: "America/New_York"
      }),
      planned_jobs: [`${sport.toUpperCase()} H2H`],
      alerts,
    });
  } catch (err) {
    console.error("[scan_error]", err);
    res.status(500).json({ ok: false, error: String(err) });
  }
});

/* ------------------------------- Start App ------------------------------- */
app.listen(PORT, () => {
  console.log(`odds-backend listening on :${PORT}`);
});
