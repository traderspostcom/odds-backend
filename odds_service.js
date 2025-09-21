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

/* ----------------- NFL helpers (raw + normalized) ----------------- */
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
      best: metrics.best,
      hold: metrics.hold,
      devig: metrics.devig
    };
    if (minHold == null || metrics.hold <= minHold) out.push(row);
  }
  return out;
}

/* ----------------- Shared Odds API fetcher ----------------- */
const ODDS_API_BASE = process.env.ODDS_API_BASE || "https://api.the-odds-api.com/v4";
const ODDS_API_KEY  = process.env.ODDS_API_KEY;

async function fetchH2HOdds(sportKey) {
  if (!ODDS_API_KEY) throw new Error("Missing ODDS_API_KEY env var");
  const url =
    `${ODDS_API_BASE}/sports/${sportKey}/odds/?` +
    `apiKey=${encodeURIComponent(ODDS_API_KEY)}&regions=us&markets=h2h&oddsFormat=american&dateFormat=iso`;
  const resp = await fetch(url);
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Odds API ${resp.status} ${resp.statusText} – ${text}`);
  }
  return resp.json();
}

/* ----------------- Utility funcs ----------------- */
function americanToProb(odds) {
  const o = Number(odds);
  if (!Number.isFinite(o)) return null;
  return o > 0 ? 100 / (o + 100) : (-o) / ((-o) + 100);
}

function prettyBookName(key, title) {
  const k = (key || "").toLowerCase();
  return BOOK_ALIASES[k] || title || key || "Unknown";
}

function betterOf(a, b) {
  if (!a) return b;
  if (!b) return a;
  if (a.price !== b.price) return a.price > b.price ? a : b;
  const ia = BOOK_PRIORITY.indexOf((a.key || "").toLowerCase());
  const ib = BOOK_PRIORITY.indexOf((b.key || "").toLowerCase());
  if (ia === -1 && ib === -1) return a;
  if (ia === -1) return b;
  if (ib === -1) return a;
  return ia < ib ? a : b;
}

/* ----------------- Normalization logic ----------------- */
function normalizeGames(games, { minHold } = {}) {
  const out = [];
  for (const g of games || []) {
    const home = g.home_team;
    const away = g.away_team || (g.teams ? g.teams.find((t) => t !== home) : null);
    if (!home || !away) continue;

    let bestAway = null;
    let bestHome = null;

    for (const bk of g.bookmakers || []) {
      const key = (bk.key || "").toLowerCase();
      if (!ALLOWED_BOOKS.has(key)) continue;

      const label = prettyBookName(key, bk.title);
      const m = (bk.markets || []).find((m) => m.key === "h2h");
      if (!m) continue;

      const awayOutcome = m.outcomes.find((o) => o.name === away);
      const homeOutcome = m.outcomes.find((o) => o.name === home);

      if (awayOutcome) {
        const cand = { key, book: label, price: Number(awayOutcome.price) };
        bestAway = betterOf(bestAway, cand);
      }
      if (homeOutcome) {
        const cand = { key, book: label, price: Number(homeOutcome.price) };
        bestHome = betterOf(bestHome, cand);
      }
    }

    if (!bestAway || !bestHome) continue;

    const pAway = americanToProb(bestAway.price);
    const pHome = americanToProb(bestHome.price);
    if (pAway == null || pHome == null) continue;

    const hold = pAway + pHome - 1;
    const sum = pAway + pHome || 1;
    const devigAway = pAway / sum;
    const devigHome = pHome / sum;

    out.push({
      gameId: g.id,
      commence_time: g.commence_time,
      home,
      away,
      hold,
      devig: { [away]: devigAway, [home]: devigHome },
      best: { [away]: bestAway, [home]: bestHome }
    });
  }

  out.sort((a, b) => (a.hold ?? 0) - (b.hold ?? 0));
  return out;
}

/* ----------------- Multi-sport exports ----------------- */
export async function getMLBH2HNormalized({ minHold } = {}) {
  const games = await fetchH2HOdds("baseball_mlb");
  return normalizeGames(games, { minHold });
}

export async function getNBAH2HNormalized({ minHold } = {}) {
  const games = await fetchH2HOdds("basketball_nba");
  return normalizeGames(games, { minHold });
}

export async function getNCAAFH2HNormalized({ minHold } = {}) {
  const games = await fetchH2HOdds("americanfootball_ncaaf");
  return normalizeGames(games, { minHold });
}

export async function getNCAABH2HNormalized({ minHold } = {}) {
  const games = await fetchH2HOdds("basketball_ncaab");
  return normalizeGames(games, { minHold });
}

export async function getTennisH2HNormalized({ minHold } = {}) {
  const atp = await fetchH2HOdds("tennis_atp");
  return normalizeGames(atp, { minHold });
}

export async function getSoccerH2HNormalized({ minHold } = {}) {
  const mls = await fetchH2HOdds("soccer_usa_mls");
  return normalizeGames(mls, { minHold });
}
