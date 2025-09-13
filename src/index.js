import "dotenv/config";
import express from "express";
import cors from "cors";
import { getNFLH2HRaw, getNFLH2HNormalized } from "./odds_service.js";

const app = express();
app.use(cors());

// (optional) tiny request logger
app.use((req, _res, next) => {
  console.log(req.method, req.url);
  next();
});

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

// Normalized with metrics
// Supports query: ?minHold=0.03&limit=10&compact=true
app.get("/api/nfl/h2h", async (req, res) => {
  try {
    const minHold = req.query.minHold ? Number(req.query.minHold) : null;
    const limit = req.query.limit ? Math.max(1, Number(req.query.limit)) : null;
    const compact = String(req.query.compact || "").toLowerCase() === "true";

    const data = await getNFLH2HNormalized({ minHold });

    let out = data;
    if (limit) out = out.slice(0, limit);

    if (compact) {
      out = out.map((g) => {
        const teamNames = Object.keys(g.best);
        const teamA = teamNames[0];
        const teamB = teamNames[1];
        return {
          gameId: g.gameId,
          time: g.commence_time,
          home: g.home,
          away: g.away,
          hold: Number(g.hold.toFixed(4)),
          devig: {
            [teamA]: Number(g.devig[teamA].toFixed(4)),
            [teamB]: Number(g.devig[teamB].toFixed(4)),
          },
          best: {
            [teamA]: { book: g.best[teamA].book, price: g.best[teamA].price },
            [teamB]: { book: g.best[teamB].book, price: g.best[teamB].price },
          },
        };
      });
    }

    res.json(out);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
