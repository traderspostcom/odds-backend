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
// ======= ADD BELOW YOUR EXISTING NFL HELPERS =======

// The Odds API settings (already used for NFL raw)
const ODDS_API_BASE = process.env.ODDS_API_BASE || "https://api.the-odds-api.com/v4";
const ODDS_API_KEY  = process.env.ODDS_API_KEY;

// Helper: fetch h2h odds for a sport key from The Odds API
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

// Helper: convert American odds → implied probability
function americanToProb(odds) {
  const o = Number(odds);
  if (!Number.isFinite(o)) return null;
  return o > 0 ? 100 / (o + 100) : (-o) / ((-o) + 100);
}

// Helper: normalize a list of Odds API games to your NFL-like shape
function normalizeGames(games, { minHold } = {}) {
  const out = [];

  for (const g of games || []) {
    const home = g.home_team;
    const away = g.away_team || (g.teams ? g.teams.find((t) => t !== home) : null);
    if (!home || !away) continue;

    let bestAway = null;
    let bestHome = null;

    for (const bk of g.bookmakers || []) {
      const m = (bk.markets || []).find((m) => m.key === "h2h");
      if (!m) continue;

      const awayOutcome = m.outcomes.find((o) => o.name === away);
      const homeOutcome = m.outcomes.find((o) => o.name === home);

      if (awayOutcome) {
        const price = Number(awayOutcome.price);
        if (!bestAway || price > bestAway.price) bestAway = { book: bk.title || bk.key, price };
      }
      if (homeOutcome) {
        const price = Number(homeOutcome.price);
        if (!bestHome || price > bestHome.price) bestHome = { book: bk.title || bk.key, price };
      }
    }

    if (!bestAway || !bestHome) continue;

    const pAway = americanToProb(bestAway.price);
    const pHome = americanToProb(bestHome.price);
    if (pAway == null || pHome == null) continue;

    const hold = pAway + pHome - 1; // book margin (can be < 0 if arbing)
    // If you want to filter here, uncomment the next line (choose your rule):
    // if (typeof minHold === "number" && hold > minHold) continue;

    const sum = pAway + pHome;
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

  // Sort by lower hold first (tends to be more interesting)
  out.sort((a, b) => (a.hold ?? 0) - (b.hold ?? 0));
  return out;
}

// ------------- Per-sport normalized fetchers (exports) -------------
// These mirror your getNFLH2HNormalized sig
