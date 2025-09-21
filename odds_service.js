// src/odds_service.js
import { bestLinesAndMetrics } from "./odds_math.js";

const ODDS_API_BASE = process.env.ODDS_API_BASE || "https://api.the-odds-api.com/v4";
const ODDS_API_KEY = process.env.ODDS_API_KEY;

/* ================== Helpers ================== */

// Convert American odds → implied probability
function americanToProb(odds) {
  const o = Number(odds);
  if (!Number.isFinite(o)) return null;
  return o > 0 ? 100 / (o + 100) : (-o) / ((-o) + 100);
}

// Map provider keys → pretty names
const BOOK_ALIASES = {
  betmgm: "BetMGM",
  caesars: "Caesars",
  draftkings: "DraftKings",
  fanduel: "FanDuel",
  fanatics: "Fanatics",
  espnbet: "ESPN BET",
  betrivers: "BetRivers",
  betonlineag: "BetOnline",
  bovada: "Bovada",
  mybookieag: "MyBookie.ag",
  williamhill: "William Hill",
  pinnacle: "Pinnacle",
  betfair: "Betfair Exchange",
  unibet: "Unibet",
};

const ALLOWED_BOOKS = new Set(
  (process.env.ALLOWED_BOOKS ||
    Object.keys(BOOK_ALIASES).join(",")
  ).split(",").map(s => s.trim().toLowerCase())
);

const BOOK_PRIORITY = [
  "pinnacle","betfair","betmgm","caesars","draftkings","fanduel","fanatics",
  "betrivers","betonlineag","bovada","mybookieag"
];

// Pick better line (tie-breaker by priority)
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

function prettyBookName(key, title) {
  const k = (key || "").toLowerCase();
  return BOOK_ALIASES[k] || title || key || "Unknown";
}

/* ================== Fetcher ================== */

// Fetch odds for any sport + market
async function fetchOdds(sportKey, marketKey) {
  if (!ODDS_API_KEY) throw new Error("Missing ODDS_API_KEY env var");

  const url =
    `${ODDS_API_BASE}/sports/${sportKey}/odds/?` +
    `apiKey=${encodeURIComponent(ODDS_API_KEY)}&regions=us&markets=${marketKey}&oddsFormat=american&dateFormat=iso`;

  const resp = await fetch(url);
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Odds API ${resp.status} ${resp.statusText} – ${text}`);
  }
  return resp.json();
}

/* ================== Normalizer ================== */

function normalizeGames(games, marketKey, { minHold } = {}) {
  const out = [];

  for (const g of games || []) {
    const home = g.home_team;
    const away = g.away_team || (g.teams ? g.teams.find((t) => t !== home) : null);
    if (!home || !away) continue;

    let bestA = null;
    let bestB = null;

    for (const bk of g.bookmakers || []) {
      const key = (bk.key || "").toLowerCase();
      if (!ALLOWED_BOOKS.has(key)) continue;

      const label = prettyBookName(key, bk.title);
      const m = (bk.markets || []).find((m) => m.key === marketKey);
      if (!m) continue;

      if (marketKey === "h2h") {
        const awayOutcome = m.outcomes.find((o) => o.name === away);
        const homeOutcome = m.outcomes.find((o) => o.name === home);
        if (awayOutcome) bestA = betterOf(bestA, { key, book: label, price: Number(awayOutcome.price) });
        if (homeOutcome) bestB = betterOf(bestB, { key, book: label, price: Number(homeOutcome.price) });
      }

      if (marketKey === "spreads") {
        for (const o of m.outcomes) {
          if (o.name === away) bestA = betterOf(bestA, { key, book: label, price: Number(o.price), point: o.point });
          if (o.name === home) bestB = betterOf(bestB, { key, book: label, price: Number(o.price), point: o.point });
        }
      }

      if (marketKey === "totals") {
        for (const o of m.outcomes) {
          const side = o.name.toLowerCase();
          if (side === "over") bestA = betterOf(bestA, { key, book: label, price: Number(o.price), point: o.point });
          if (side === "under") bestB = betterOf(bestB, { key, book: label, price: Number(o.price), point: o.point });
        }
      }
    }

    if (!bestA || !bestB) continue;

    const pA = americanToProb(bestA.price);
    const pB = americanToProb(bestB.price);
    if (pA == null || pB == null) continue;

    const hold = pA + pB - 1;
    if (typeof minHold === "number" && hold > minHold) continue;

    const sum = pA + pB || 1;
    const devigA = pA / sum;
    const devigB = pB / sum;

    out.push({
      gameId: g.id,
      commence_time: g.commence_time,
      home,
      away,
      market: marketKey,
      hold,
      devig: { sideA: devigA, sideB: devigB },
      best: { sideA: bestA, sideB: bestB }
    });
  }

  out.sort((a, b) => (a.hold ?? 0) - (b.hold ?? 0));
  return out;
}

/* ================== Exports ================== */

// NFL
export async function getNFLH2HNormalized({ minHold } = {}) {
  const games = await fetchOdds("americanfootball_nfl", "h2h");
  return normalizeGames(games, "h2h", { minHold });
}
export async function getNFLSpreadsNormalized({ minHold } = {}) {
  const games = await fetchOdds("americanfootball_nfl", "spreads");
  return normalizeGames(games, "spreads", { minHold });
}
export async function getNFLTotalsNormalized({ minHold } = {}) {
  const games = await fetchOdds("americanfootball_nfl", "totals");
  return normalizeGames(games, "totals", { minHold });
}

// MLB
export async function getMLBH2HNormalized({ minHold } = {}) {
  const games = await fetchOdds("baseball_mlb", "h2h");
  return normalizeGames(games, "h2h", { minHold });
}
export async function getMLBSpreadsNormalized({ minHold } = {}) {
  const games = await fetchOdds("baseball_mlb", "spreads");
  return normalizeGames(games, "spreads", { minHold });
}
export async function getMLBTotalsNormalized({ minHold } = {}) {
  const games = await fetchOdds("baseball_mlb", "totals");
  return normalizeGames(games, "totals", { minHold });
}

// NBA
export async function getNBAH2HNormalized({ minHold } = {}) {
  const games = await fetchOdds("basketball_nba", "h2h");
  return normalizeGames(games, "h2h", { minHold });
}
export async function getNBASpreadsNormalized({ minHold } = {}) {
  const games = await fetchOdds("basketball_nba", "spreads");
  return normalizeGames(games, "spreads", { minHold });
}
export async function getNBATotalsNormalized({ minHold } = {}) {
  const games = await fetchOdds("basketball_nba", "totals");
  return normalizeGames(games, "totals", { minHold });
}

// NCAAF
export async function getNCAAFH2HNormalized({ minHold } = {}) {
  const games = await fetchOdds("americanfootball_ncaaf", "h2h");
  return normalizeGames(games, "h2h", { minHold });
}
export async function getNCAAFSpreadsNormalized({ minHold } = {}) {
  const games = await fetchOdds("americanfootball_ncaaf", "spreads");
  return normalizeGames(games, "spreads", { minHold });
}
export async function getNCAAFTotalsNormalized({ minHold } = {}) {
  const games = await fetchOdds("americanfootball_ncaaf", "totals");
  return normalizeGames(games, "totals", { minHold });
}

// NCAAB
export async function getNCAABH2HNormalized({ minHold } = {}) {
  const games = await fetchOdds("basketball_ncaab", "h2h");
  return normalizeGames(games, "h2h", { minHold });
}
export async function getNCAABSpreadsNormalized({ minHold } = {}) {
  const games = await fetchOdds("basketball_ncaab", "spreads");
  return normalizeGames(games, "spreads", { minHold });
}
export async function getNCAABTotalsNormalized({ minHold } = {}) {
  const games = await fetchOdds("basketball_ncaab", "totals");
  return normalizeGames(games, "totals", { minHold });
}

// Tennis (ATP only for now)
export async function getTennisH2HNormalized({ minHold } = {}) {
  const games = await fetchOdds("tennis_atp", "h2h");
  return normalizeGames(games, "h2h", { minHold });
}

// Soccer (MLS only for now)
export async function getSoccerH2HNormalized({ minHold } = {}) {
  const games = await fetchOdds("soccer_usa_mls", "h2h");
  return normalizeGames(games, "h2h", { minHold });
}
