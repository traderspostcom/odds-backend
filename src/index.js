// src/index.js
import "dotenv/config";
import express from "express";
import cors from "cors";

import {
  // NFL (you already had these)
  getNFLH2HRaw,
  getNFLH2HNormalized,
  // Make sure these are exported from ./odds_service.js (see Step 8)
  getMLBH2HNormalized,
  getNBAH2HNormalized,
  getNCAAFH2HNormalized,
  getNCAABH2HNormalized,
  getTennisH2HNormalized,
  getSoccerH2HNormalized
} from "./odds_service.js";

const app = express();
app.use(cors());

// Tiny request logger
app.use((req, _res, next) => {
  console.log(req.method, req.url);
  next();
});

/* -------------------- Health -------------------- */
app.get("/health", (_req, res) => res.json({ ok: true }));

/* -------------------- NFL: Raw (debug) -------------------- */
app.get("/api/nfl/h2h/raw", async (_req, res) => {
  try {
    const data = await getNFLH2HRaw();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

/* -------------------- NFL: Normalized --------------------
   Supports query: ?minHold=0.03&limit=10&compact=true
---------------------------------------------------------- */
app.get("/api/nfl/h2h", async (req, res) => {
  try {
    const minHold = req.query.minHold !== undefined ? Number(req.query.minHold) : null;
    const limit   = req.query.limit   !== undefined ? Math.max(1, Number(req.query.limit)) : null;
    const compact = String(req.query.compact || "").toLowerCase() === "true";

    const data = await getNFLH2HNormalized({ minHold });

    let out = Array.isArray(data) ? data : [];
    if (limit) out = out.slice(0, limit);

    if (compact) {
      out = out.map((g) => {
        const best = g.best || {};
        const teamNames = Object.keys(best);
        const teamA = teamNames[0];
        const teamB = teamNames[1];
        return {
          gameId: g.gameId,
          time: g.commence_time,
          home: g.home,
          away: g.away,
          hold: typeof g.hold === "number" ? Number(g.hold.toFixed(4)) : null,
          devig: {
            [teamA]: g.devig?.[teamA] != null ? Number(Number(g.devig[teamA]).toFixed(4)) : null,
            [teamB]: g.devig?.[teamB] != null ? Number(Number(g.devig[teamB]).toFixed(4)) : null
          },
          best: {
            [teamA]: best[teamA] ? { book: best[teamA].book, price: best[teamA].price } : null,
            [teamB]: best[teamB] ? { book: best[teamB].book, price: best[teamB].price } : null
          }
        };
      });
    }

    res.json(out);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

/* -------------------- Universal Multi-Sport H2H --------------------
   Adds: /api/{sport}/h2h for nfl, mlb, nba, ncaaf, ncaab, tennis, soccer
------------------------------------------------------------------- */
const ALLOWED_SPORTS = new Set(["nfl", "mlb", "nba", "ncaaf", "ncaab", "tennis", "soccer"]);

const FETCHERS = {
  nfl:   async ({ minHold }) => getNFLH2HNormalized({ minHold }),
  mlb:   async ({ minHold }) => getMLBH2HNormalized({ minHold }),
  nba:   async ({ minHold }) => getNBAH2HNormalized({ minHold }),
  ncaaf: async ({ minHold }) => getNCAAFH2HNormalized({ minHold }),
  ncaab: async ({ minHold }) => getNCAABH2HNormalized({ minHold }),
  tennis:async ({ minHold }) => getTennisH2HNormalized({ minHold }),
  soccer:async ({ minHold }) => getSoccerH2HNormalized({ minHold })
};

// Shared handler for all H2H routes
async function h2hHandler(req, res) {
  try {
    const sport = String(req.params.sport || "").toLowerCase();
    if (!ALLOWED_SPORTS.has(sport)) {
      return res.status(400).json({ error: "unsupported_sport", sport });
    }

    const minHold = req.query.minHold !== undefined ? Number(req.query.minHold) : null;
    const limit   = req.query.limit   !== undefined ? Math.max(1, Number(req.query.limit)) : null;
    const compact = String(req.query.compact || "").toLowerCase() === "true";

    const fetcher = FETCHERS[sport];

    if (typeof fetcher !== "function") {
      // Soft-fail so clients don't break if a sport isn't implemented yet.
      res.set("x-warning", "not_implemented");
      return res.status(200).json([]);
    }

    let data = await fetcher({ minHold });
    if (!Array.isArray(data)) data = [];

    if (limit) data = data.slice(0, limit);

    if (compact) {
      data = data.map((g) => {
        const best  = g.best || g.best_prices || {};
        const devig = g.devig || {};
        const teamNames = Object.keys(best);
        const teamA = teamNames[0] || g.away || "Away";
        const teamB = teamNames[1] || g.home || "Home";
        const holdVal = typeof g.hold === "number" ? g.hold : (g.evidence?.hold ?? null);

        return {
          gameId: g.gameId || g.event_id || null,
          time: g.commence_time || g.start_time || null,
          home: g.home,
          away: g.away,
          hold: holdVal != null ? Number(Number(holdVal).toFixed(4)) : null,
          devig: {
            [teamA]: devig[teamA] != null ? Number(Number(devig[teamA]).toFixed(4)) : null,
            [teamB]: devig[teamB] != null ? Number(Number(devig[teamB]).toFixed(4)) : null
          },
          best: {
            [teamA]: best[teamA] ? { book: best[teamA].book, price: best[teamA].price } : null,
            [teamB]: best[teamB] ? { book: best[teamB].book, price: best[teamB].price } : null
          }
        };
      });
    }

    res.json(data);
  } catch (e) {
    console.error("multi-sport h2h error:", e);
    res.status(500).json({ error: String(e) });
  }
}

// Dynamic route
app.get("/api/:sport/h2h", h2hHandler);

// Explicit aliases so /api/mlb/h2h, /api/nba/h2h, etc. always exist
["mlb", "nba", "ncaaf", "ncaab", "tennis", "soccer"].forEach((sport) => {
  app.get(`/api/${sport}/h2h`, (req, res) => {
    req.params.sport = sport;
    return h2hHandler(req, res);
  });
});
/* ------------- End Universal Multi-Sport H2H ------------- */

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
