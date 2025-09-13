import "dotenv/config";
import express from "express";
import cors from "cors";
import { getNFLH2HRaw, getNFLH2HNormalized } from "./odds_service.js";

const app = express();
app.use(cors());

// Health check
app.get("/health", (_req, res) => res.json({ ok: true }));

// Raw NFL moneyline odds (debugging)
app.get("/api/nfl/h2h/raw", async (_req, res) => {
  try {
    const data = await getNFLH2HRaw();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Normalized odds with metrics (best price per team, hold, devig)
// Optional query param: ?minHold=0.03  (keeps only games with hold ≤ 3%)
app.get("/api/nfl/h2h", async (req, res) => {
  try {
    const minHold = req.query.minHold ? Number(req.query.minHold) : null;
    const data = await getNFLH2HNormalized({ minHold });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
