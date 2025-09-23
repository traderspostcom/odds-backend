// src/fetchers.js
// Centralized map of all sport/market fetchers + safety guards.
// All network access should go through here (and then through odds_service).

import * as odds from "../odds_service.js";

/* -------------------- Env helpers -------------------- */
export const isOn = (key, def = false) => {
  const v = String(process.env[key] ?? "").trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  return !!def;
};

const ODDS_API_ENABLED = process.env.ODDS_API_ENABLED !== "false"; // master OFF if 'false'
const BOOKS_WHITELIST = (process.env.BOOKS_WHITELIST || "pinnacle,circa,cris")
  .split(",")
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);

const MAX_EVENTS_PER_CALL = Number(process.env.MAX_EVENTS_PER_CALL || 20); // cap event volume
const MAX_BOOKS_PER_CALL  = Number(process.env.MAX_BOOKS_PER_CALL  || 3);  // defensive: keep small

/* -------------------- Safe call wrapper -------------------- */
/**
 * Wraps a normalized fetcher to:
 *  - Respect ODDS_API_ENABLED master switch
 *  - Inject book whitelist (when the underlying fetcher supports args.books)
 *  - Clamp events/books if the upstream fetcher supports args.{limit,books}
 *  - Catch 422/unsupported fast without throwing up-stack
 */
function wrapFetcher(label, fn) {
  return async (args = {}) => {
    if (!ODDS_API_ENABLED) {
      console.warn(`🛑 Provider disabled (ODDS_API_ENABLED=false) for ${label}`);
      return []; // Pretend empty; callers should handle gracefully
    }

    // Normalize args
    const a = { ...(args || {}) };

    // Books whitelisting
    if (!a.books && Array.isArray(BOOKS_WHITELIST) && BOOKS_WHITELIST.length) {
      a.books = BOOKS_WHITELIST.slice(0, MAX_BOOKS_PER_CALL);
    } else if (Array.isArray(a.books)) {
      a.books = a.books
        .map(b => String(b).toLowerCase())
        .filter(b => BOOKS_WHITELIST.includes(b))
        .slice(0, MAX_BOOKS_PER_CALL);
    }

    // --- Odds API → snapshot (NFL H2H) ---
const BOOKS_WHITELIST = (process.env.BOOKS_WHITELIST || "")
  .split(",")
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);

function filterBookKey(key) {
  if (!key) return false;
  const k = String(key).toLowerCase();
  if (BOOKS_WHITELIST.length === 0) return true; // no filter
  return BOOKS_WHITELIST.includes(k);
}

function toAmerican(n) {
  // assume Odds API already returns american when oddsFormat=american
  // but guard just in case it’s numeric string
  if (n == null) return null;
  const num = Number(n);
  return Number.isFinite(num) ? num : null;
}
// GPT SUPPORT
export function mapOddsEventToNFLH2HSnapshot(ev) {
  // ev fields per Odds API v4: id, sport_key, commence_time, home_team, away_team, bookmakers: [{ key, title, markets: [{ key, outcomes: [...] }] }]
  const home = ev.home_team;
  const away = ev.away_team;

  // Collect H2H market from each bookmaker
  const offers = [];
  for (const bm of ev.bookmakers || []) {
    const bookKey = (bm.key || bm.title || "").toLowerCase();
    if (!filterBookKey(bookKey)) continue;

    const h2h = (bm.markets || []).find(m => (m.key || "").toLowerCase() === "h2h");
    if (!h2h || !Array.isArray(h2h.outcomes)) continue;

    // Find prices for home/away by matching team names (Odds API uses team names in outcomes.name)
    const oHome = h2h.outcomes.find(o => (o.name || "").toLowerCase() === (home || "").toLowerCase());
    const oAway = h2h.outcomes.find(o => (o.name || "").toLowerCase() === (away || "").toLowerCase());
    if (!oHome || !oAway) continue;

    const homeAmerican = toAmerican(oHome.price);
    const awayAmerican = toAmerican(oAway.price);
    if (homeAmerican == null || awayAmerican == null) continue;

    offers.push({
      book: bookKey,
      prices: {
        home: { american: homeAmerican },
        away: { american: awayAmerican },
      },
    });
  }

  return {
    sport: "nfl",
    market: "NFL H2H",
    gameId: ev.id,
    home,
    away,
    commence_time: ev.commence_time, // UTC ISO from Odds API
    // no splits for your plan, so tickets/handle undefined
    offers, // <<< critical for EV analyzer
  };
}


    // Event cap (if upstream honors it)
    if (a.limit == null) a.limit = MAX_EVENTS_PER_CALL;

    try {
      const out = await fn(a);
      return Array.isArray(out) ? out : [];
    } catch (err) {
      const msg = String(err?.message || err);
      if (msg.includes("INVALID_MARKET") || msg.includes("Markets not supported") || msg.includes("status=422")) {
        console.warn(`⚠️  Skipping unsupported market: ${label}`);
        return [];
      }
      // Let outer retry (in index.js) decide on 429s etc.
      throw err;
    }
  };
}

/* -------------------- FETCHERS (single source of truth) -------------------- */
/**
 * Every function below must be a **wrapped** version of the raw odds_service export.
 * If a raw fetcher is absent (undefined), keep it undefined; callers gate by existence.
 */
export const FETCHERS = {
  nfl: {
    // Full game
    h2h:     odds.getNFLH2HNormalized     ? wrapFetcher("NFL H2H",     odds.getNFLH2HNormalized)     : undefined,
    spreads: odds.getNFLSpreadsNormalized ? wrapFetcher("NFL Spreads", odds.getNFLSpreadsNormalized) : undefined,
    totals:  odds.getNFLTotalsNormalized  ? wrapFetcher("NFL Totals",  odds.getNFLTotalsNormalized)  : undefined,

    // First Half (optional; only used if defined upstream)
    h1_h2h:     odds.getNFLH1H2HNormalized     ? wrapFetcher("NFL 1H H2H",     odds.getNFLH1H2HNormalized)     : undefined,
    h1_spreads: odds.getNFLH1SpreadsNormalized ? wrapFetcher("NFL 1H Spreads", odds.getNFLH1SpreadsNormalized) : undefined,
    h1_totals:  odds.getNFLH1TotalsNormalized  ? wrapFetcher("NFL 1H Totals",  odds.getNFLH1TotalsNormalized)  : undefined
  },

  mlb: {
    h2h:         odds.getMLBH2HNormalized        ? wrapFetcher("MLB H2H",         odds.getMLBH2HNormalized)        : undefined,
    spreads:     odds.getMLBSpreadsNormalized    ? wrapFetcher("MLB Spreads",     odds.getMLBSpreadsNormalized)    : undefined,
    totals:      odds.getMLBTotalsNormalized     ? wrapFetcher("MLB Totals",      odds.getMLBTotalsNormalized)     : undefined,

    // First 5
    f5_h2h:      odds.getMLBF5H2HNormalized      ? wrapFetcher("MLB F5 H2H",      odds.getMLBF5H2HNormalized)      : undefined,
    f5_totals:   odds.getMLBF5TotalsNormalized   ? wrapFetcher("MLB F5 Totals",   odds.getMLBF5TotalsNormalized)   : undefined,

    // Extras (often unsupported on base plans)
    team_totals: odds.getMLBTeamTotalsNormalized ? wrapFetcher("MLB Team Totals", odds.getMLBTeamTotalsNormalized) : undefined,
    alt:         odds.getMLBAltLinesNormalized   ? wrapFetcher("MLB Alt",         odds.getMLBAltLinesNormalized)   : undefined
  },

  nba: {
    h2h:     odds.getNBAH2HNormalized     ? wrapFetcher("NBA H2H",     odds.getNBAH2HNormalized)     : undefined,
    spreads: odds.getNBASpreadsNormalized ? wrapFetcher("NBA Spreads", odds.getNBASpreadsNormalized) : undefined,
    totals:  odds.getNBATotalsNormalized  ? wrapFetcher("NBA Totals",  odds.getNBATotalsNormalized)  : undefined
  },

  ncaaf: {
    h2h:     odds.getNCAAFH2HNormalized     ? wrapFetcher("NCAAF H2H",     odds.getNCAAFH2HNormalized)     : undefined,
    spreads: odds.getNCAAFSpreadsNormalized ? wrapFetcher("NCAAF Spreads", odds.getNCAAFSpreadsNormalized) : undefined,
    totals:  odds.getNCAAFTotalsNormalized  ? wrapFetcher("NCAAF Totals",  odds.getNCAAFTotalsNormalized)  : undefined
  },

  ncaab: {
    h2h:     odds.getNCAABH2HNormalized     ? wrapFetcher("NCAAB H2H",     odds.getNCAABH2HNormalized)     : undefined,
    spreads: odds.getNCAABSpreadsNormalized ? wrapFetcher("NCAAB Spreads", odds.getNCAABSpreadsNormalized) : undefined,
    totals:  odds.getNCAABTotalsNormalized  ? wrapFetcher("NCAAB Totals",  odds.getNCAABTotalsNormalized)  : undefined
  },

  tennis: {
    h2h: odds.getTennisH2HNormalized ? wrapFetcher("Tennis H2H", odds.getTennisH2HNormalized) : undefined
  },

  soccer: {
    h2h: odds.getSoccerH2HNormalized ? wrapFetcher("Soccer H2H", odds.getSoccerH2HNormalized) : undefined
  }
};
