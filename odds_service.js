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

/* ------------------------------------------------------------------
   BOOK CONFIG (aliases, allow-list, tie-break) — comprehensive set
------------------------------------------------------------------- */

// Map provider keys → pretty brand names (covers common variants)
const BOOK_ALIASES = {
  // --- US ---
  betmgm: "BetMGM",
  caesars: "Caesars",
  williamhill_us: "William Hill",
  williamhill: "William Hill",
  draftkings: "DraftKings",
  fanduel: "FanDuel",
  fanatics: "Fanatics",
  fanatics_sportsbook: "Fanatics",
  espnbet: "ESPN BET",
  betrivers: "BetRivers",
  betparx: "BetPARX",
  betonlineag: "BetOnline",
  betonline: "BetOnline",
  bovada: "Bovada",
  mybookieag: "MyBookie.ag",
  mybookie: "MyBookie.ag",

  // --- UK / Ireland ---
  betfair: "Betfair",
  betfair_exchange: "Betfair",
  betvictor: "Bet Victor",
  ladbrokes: "Ladbrokes",
  matchbook: "Matchbook",
  paddypower: "Paddy Power",
  paddy_power: "Paddy Power",
  unibet: "Unibet",

  // --- EU / Intl ---
  "1xbet": "1xBet",
  betclic: "Betclic",
  betsson: "Betsson",
  pinnacle: "Pinnacle",

  // --- Australia / NZ ---
  neds: "Neds",
  sportsbet: "Sportsbet",
  tab: "TAB",
  ladbrokes_au: "Ladbrokes",
  unibet_au: "Unibet"
};

// Comma-separated env var to control which books your API keeps.
// Default includes the full list above.
// Example (US-only) in Render: ALLOWED_BOOKS="betmgm,caesars,draftkings,fanduel,fanatics,espnbet,betrivers,betparx,betonlineag,bovada,mybookieag"
const ALLOWED_BOOKS = new Set(
  (process.env.ALLOWED_BOOKS ||
    [
      // US
      "betmgm","caesars","draftkings","fanduel","fanatics","espnbet",
      "betrivers","betparx","betonlineag","betonline","bovada","mybookieag","mybookie","williamhill_us","williamhill",
      // UK/IE
      "betfair","betfair_exchange","betvictor","ladbrokes","matchbook","paddypower","paddy_power","unibet",
      // EU / Intl
      "1xbet","betclic","betsson","pinnacle",
      // AU/NZ
      "neds","sportsbet","tab","ladbrokes_au","unibet_au"
    ].join(",")
  )
  .split(",")
  .map(s => s.trim().toLowerCase())
);

// Priority to break ties when prices are equal (left = highest priority)
const BOOK_PRIORITY = [
  // Sharp/exchanges first
  "pinnacle","betfair_exchange","betfair","matchbook",
  // Major US books
  "williamhill","williamhill_us","caesars","betmgm","draftkings","fanduel","fanatics",
  "betrivers","betparx","betonlineag","betonline","bovada","mybookieag","mybookie",
  // UK/EU
  "unibet","betvictor","paddypower","ladbrokes","betclic","betsson","1xbet",
  // AU
  "sportsbet","tab","neds","ladbrokes_au","unibet_au"
];

function prettyBookName(key, title) {
  const k = (key || "").toLowerCase();
  return BOOK_ALIASES[k] || title || key || "Unknown";
}

function betterOf(a, b) {
  // Pick by higher American price; if equal, prefer by BOOK_PRIORITY order
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

/* ------------------------------------------------------------------
   Helper: normalize a list of Odds API games to NFL-like shape
   (now with book filtering, labels, and tie-break)
------------------------------------------------------------------- */
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
      if (!ALLOWED_BOOKS.has(key)) continue; // filter to your chosen books

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

    const hold = pAway + pHome - 1; // book margin (can be < 0 if arbing)
    // If you want to filter here, uncomment the next line (choose your rule):
    // if (typeof minHold === "number" && hold > minHold) continue;

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

  // Sort by lower hold first (tends to be more interesting)
  out.sort((a, b) => (a.hold ?? 0) - (b.hold ?? 0));
  return out;
}

// ------------- Per-sport normalized fetchers (exports) -------------
// These mirror your getNFLH2HNormalized signature: ({ minHold }) => Promise<array>

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

// Tennis has multiple tours; start with ATP (add WTA similarly if you want)
export async function getTennisH2HNormalized({ minHold } = {}) {
  const atp = await fetchH2HOdds("tennis_atp");
  // If you also want WTA, fetch and concat:
  // const wta = await fetchH2HOdds("tennis_wta");
  // const games = [...atp, ...wta];
  return normalizeGames(atp, { minHold });
}

// Soccer has many leagues; start with MLS (add EPL/others later)
export async function getSoccerH2HNormalized({ minHold } = {}) {
  const mls = await fetchH2HOdds("soccer_usa_mls");
  // To include more leagues, fetch each and concat them into one array.
  return normalizeGames(mls, { minHold });
}
// ================= END ADDITION =======
