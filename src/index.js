// src/index.js
import "dotenv/config";
import express from "express";
import cors from "cors";

// Existing NFL fetchers
import { getNFLH2HRaw, getNFLH2HNormalized } from "./odds_service.js";

// If/when you add other sports, export their fetchers from odds_service.js
// and uncomment these lines:
// import {
//   getMLBH2HNormalized,
//   getNBAH2HNormalized,
//   getNCAAFH2HNormalized,
//   getNCAABH2HNormalized,
//   getTennisH2HNormalized,
//   getSoccerH2HNormalized
// } from "./odds_service.js";

const app = express();
app.use(cors());

// Tiny request logger (optional)
app.use((req, _res, next) => {
  console.log(req.method, req.url);
  next();
});

// -------------------- Health --------------------
app.get("/health", (_req, res) => res.json({ ok: true }));

// -------------------- NFL: Raw (debug) --------------------
app.get("/api/nfl/h2h/raw", async (_req, res) => {
  try {
    const data = await getNFLH2HRaw();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// -------------------- NFL: Normalized --------------------
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

// -------------------- Universal Multi-Sport H2H --------------------
// This adds: /api/{sport}/h2h for nfl, mlb, nba, ncaaf, ncaab, tennis, soccer
// Returns [] for sports you haven't wired yet (so tools don't error).
const ALLOWED_SPORTS = new Set(["nfl", "mlb", "nba", "ncaaf", "ncaab", "tennis", "soccer"]);

// Map sport -> fetcher. Start with NFL; add others as you implement & export them.
const FETCHERS = {
  nfl: async ({ minHold }) => getNFLH2HNormalized({ minHold }),
  // mlb: async ({ minHold }) => getMLBH2HNormalized({ minHold }),
  // nba: async ({ minHold }) => getNBAH2HNormalized({ minHold }),
  // ncaaf: async ({ minHold }) => getNCAAFH2HNormalized({ minHold }),
  // ncaab: async ({ minHold }) => getNCAABH2HNormalized({ minHold }),
  // tennis: async ({ minHold }) => getTennisH2HNormalized({ minHold }),
  // soccer: async ({ minHold }) => getSoccerH2HNormalized({ minHold }),
};

// Generic H2H endpoint for all sports.
// Query params: ?minHold=0.02&limit=5&compact=true
// Shape of compact output mirrors your NFL compact response as best as possible.
app.get("/api/:sport/h2h", async (req, res) => {
  try {
    const sport = String(req.params.sport || "").toLowerCase();
    if (!ALLOWED_SPORTS.has(sport)) {
      return res.status(400).json({ error: "unsupported_sport", sport });
    }

    const minHold = req.query.minHold !== undefined ? Number(req.query.minHold) : null;
    const limit = req.query.limit !== undefined ? Math.max(1, Number(req.query.limit)) : null;
    const compact = String(req.query.compact || "").toLowerCase() === "true";

    const fetcher = FETCHERS[sport];

    // If sport not wired yet, return empty list (200) so the client doesn't error out.
    if (typeof fetcher !== "function") {
      res.set("x-warning", "not_implemented");
      return res.status(200).json([]);
    }

    let data = await fetcher({ minHold });
    if (!Array.isArray(data)) data = [];

    // Apply limit consistently
    if (limit) data = data.slice(0, limit);

    // Compact view: normalize common fields
    if (compact) {
      data = data.map((g) => {
        // Try to adapt to either your NFL shape or possible alt shapes
        const best = g.best || g.best_prices || {};
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
          hold: holdVal !== null ? Number(Number(holdVal).toFixed(4)) : null,
          devig: {
            [teamA]: devig[teamA] != null ? Number(Number(devig[teamA]).toFixed(4)) : null,
            [teamB]: devig[teamB] != null ? Number(Number(devig[teamB]).toFixed(4)) : null,
          },
          best: {
            [teamA]: best[teamA] ? { book: best[teamA].book, price: best[teamA].price } : null,
            [teamB]: best[teamB] ? { book: best[teamB].book, price: best[teamB].price } : null,
          },
        };
      });
    }

    res.json(data);
  } catch (e) {
    console.error("mul
