// src/odds_service.js
import { bestLinesAndMetrics } from "./odds_math.js";

const BASE = "https://api.the-odds-api.com/v4";

// simple in-memory cache so we don't spam the API
const cache = { nfl_h2h: { data: null, ts: 0 } };
const ttlMs = Number(process.env.CACHE_TTL_SECONDS || 30) * 1000;

async function fetchJSON(url) {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  // Log rate-limit headers if present
  const remaining = res.headers.get("x-requests-remaining");
  const used = res.headers.get("x-requests-used");
  if (remaining || used) console.log(`[oddsapi] remaining=${remaining} used=${used}`);
  return JSON.parse(text);
}

export async function getNFLH2HRaw() {
  const now = Date.now();
  if (cache.nfl_h2h.data && now - cache.nfl_h2h.ts < ttlMs) {
    return cache.nfl_h2h.data;
  }
  const url = new URL(`${BASE}/sports/americanfootball_nfl/odds`);
  url.search = new URLSearchParams({
    apiKey: process.env.ODDS_API_KEY,
    regions: "us",
    markets: "h2h",
    oddsFormat: "american"
  });

  const data = await fetchJSON(url.toString());
  cache.nfl_h2h = { data, ts: now };
  return data;
}

export async function getNFLH2HNormalized({ minHold = null } = {}) {
  const data = await getNFLH2HRaw();
  const out = [];

  for (const g of data) {
    const metrics = bestLinesAndMetrics(g);
    if (!metrics) continue;

    const gameId = g.id || `${g.commence_time}|${g.home_team}|${g.away_team}`;
    const row = {
      gameId,
      commence_time: g.commence_time,
      home: g.home_team,
      away: g.away_team,
      best: metrics.best, // best price per team across books
      hold: metrics.hold, // market hold (vig)
      devig: metrics.devig // de-vigged probabilities
    };
    if (minHold == null || metrics.hold <= minHold) out.push(row);
  }
  return out;
}
