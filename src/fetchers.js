// src/fetchers.js
// Two-step fetching to control credits:
// 1) List eventIds (cheap): /v4/sports/{sportKey}/events?daysFrom=1
// 2) Fetch odds per event:  /v4/sports/{sportKey}/events/{eventId}/odds?markets=h2h&...

const ODDS_BASE = "https://api.the-odds-api.com/v4";

/* ================================ ENV / KNOBS ================================ */
const ODDS_ENABLED = () => (String(process.env.ODDS_API_ENABLED || "true").toLowerCase() === "true");
const API_KEY = () => process.env.ODDS_API_KEY || "";
const getRegion = () =>
  (process.env.ODDS_API_REGION || "us")
    .split(",").map(s => s.trim()).filter(Boolean).join(",");
const getBooksWhitelist = () =>
  (process.env.BOOKS_WHITELIST || "pinnacle,draftkings,betmgm,fanduel,caesars,bet365")
    .split(",").map(s => s.trim()).filter(Boolean);

// How far ahead to list events (in days). Small = fewer IDs returned = less burn later.
const EVENTS_DAYS_FROM = Number(process.env.ODDS_EVENTS_DAYS || 1);

// Small TTL (seconds) to avoid double-list calls during quick manual tests.
const EVENTS_CACHE_TTL = Number(process.env.CACHE_TTL_SECONDS || 30);

/* ================================ CACHE (IDs) ================================ */
const _eventsCache = new Map(); // key -> { ts, data }
function _cacheKeyEvents(sportKey) {
  return `events:${sportKey}:daysFrom=${EVENTS_DAYS_FROM}`;
}
function _getCachedEvents(sportKey) {
  const k = _cacheKeyEvents(sportKey);
  const entry = _eventsCache.get(k);
  if (!entry) return null;
  if ((Date.now() - entry.ts) / 1000 > EVENTS_CACHE_TTL) {
    _eventsCache.delete(k);
    return null;
  }
  return entry.data;
}
function _setCachedEvents(sportKey, data) {
  const k = _cacheKeyEvents(sportKey);
  _eventsCache.set(k, { ts: Date.now(), data });
}

/* =========================== LOW-LEVEL PROVIDER CALLS ======================== */
async function fetchJson(url) {
  const r = await fetch(url);
  if (!r.ok) return null;
  try { return await r.json(); } catch { return null; }
}

// 1) List events (cheap)
async function fetchEventIds(sportKey) {
  if (!ODDS_ENABLED()) return [];
  const key = API_KEY(); if (!key) return [];

  const params = new URLSearchParams({
    apiKey: key,
    daysFrom: String(EVENTS_DAYS_FROM),
  });
  const url = `${ODDS_BASE}/sports/${sportKey}/events?${params.toString()}`;

  // cache
  const cached = _getCachedEvents(sportKey);
  if (cached) return cached;

  const data = await fetchJson(url);
  if (!Array.isArray(data)) return [];
  // Keep just the fields we need
  const events = data.map(e => ({
    id: e.id,
    sport_key: e.sport_key,
    commence_time: e.commence_time,
    home_team: e.home_team,
    away_team: e.away_team,
  })).filter(e => e && e.id);

  _setCachedEvents(sportKey, events);
  return events;
}

// 2) Fetch odds for a single eventId (predictable burn = per-event × books)
async function fetchOddsForEvent(sportKey, eventId, market, extra = {}) {
  if (!ODDS_ENABLED()) return null;
  const apiKey = API_KEY(); if (!apiKey) return null;

  const params = new URLSearchParams({
    apiKey,
    regions: getRegion(),
    markets: market,              // e.g., "h2h"
    oddsFormat: "american",
    dateFormat: "iso",
    bookmakers: getBooksWhitelist().join(","),
  });
  for (const [k, v] of Object.entries(extra)) {
    if (v !== undefined && v !== null && v !== "") params.set(k, String(v));
  }

  const url = `${ODDS_BASE}/sports/${sportKey}/events/${eventId}/odds?${params.toString()}`;
  const data = await fetchJson(url);
  if (!data || typeof data !== "object") return null;

  // The event odds shape: { id, sport_key, commence_time, home_team, away_team, bookmakers: [...] }
  const booksAllowed = new Set(getBooksWhitelist());
  const books = Array.isArray(data.bookmakers)
    ? data.bookmakers
        .filter(bm => bm && booksAllowed.has(String(bm.key || "").toLowerCase()))
        .map(bm => ({
          key: bm.key,
          title: bm.title,
          last_update: bm.last_update,
          markets: bm.markets || [],
        }))
    : [];

  return {
    id: data.id,
    sport_key: data.sport_key,
    commence_time: data.commence_time,
    home: data.home_team,
    away: data.away_team,
    bookmakers: books,
  };
}

/* =============================== NORMALIZATION ============================== */
function normalizeH2HFromEventOdds(eventOdds, { sport, market } = {}) {
  if (!eventOdds) return null;

  const homeName = eventOdds.home || eventOdds.home_team;
  const awayName = eventOdds.away || eventOdds.away_team;

  // Aggregate one offer per BOOK with both sides nested under prices.home/away
  const offersByBook = new Map();

  for (const bm of eventOdds.bookmakers || []) {
    const bookKey = String(bm.key || "").toLowerCase();
    if (!bookKey) continue;

    if (!offersByBook.has(bookKey)) {
      offersByBook.set(bookKey, {
        book: bookKey,
        prices: {
          home: { american: undefined },
          away: { american: undefined },
        },
        last_update: bm.last_update,
      });
    }
    const entry = offersByBook.get(bookKey);

    for (const mkt of bm.markets || []) {
      if (mkt.key !== "h2h") continue;
      for (const o of mkt.outcomes || []) {
        const team = String(o.name || "");
        const price = Number(o.price);
        if (!Number.isFinite(price)) continue;

        if (team === homeName) entry.prices.home.american = price;
        else if (team === awayName) entry.prices.away.american = price;
      }
    }
  }

  const offers = Array.from(offersByBook.values()).filter(o =>
    Number.isFinite(Number(o.prices.home.american)) ||
    Number.isFinite(Number(o.prices.away.american))
  );

  return {
    id: eventOdds.id,
    gameId: eventOdds.id,
    sport,
    market,
    home: homeName,
    away: awayName,
    commence_time: eventOdds.commence_time,

    game: { away: awayName, home: homeName, start_time_utc: eventOdds.commence_time },
    offers,
    source_meta: { sport_key: eventOdds.sport_key, fetched_at: new Date().toISOString() },
  };
}

/* =========================== SPORT / MARKET WRAPPERS ======================== */
// IMPORTANT: We now respect limit/offset by FIRST selecting eventIds, THEN fetching odds per ID.
// This makes credits scale with your limit instead of the provider’s default batch.

export async function getNFLH2HNormalized({ limit = 3, offset = 0 } = {}) {
  const sportKey = "americanfootball_nfl";
  const market = "h2h";
  const list = await fetchEventIds(sportKey);
  const slice = (list || []).slice(offset, offset + limit);
  const out = [];
  for (const ev of slice) {
    const odds = await fetchOddsForEvent(sportKey, ev.id, market);
    const norm = normalizeH2HFromEventOdds(odds, { sport: "nfl", market: "NFL H2H" });
    if (norm) out.push(norm);
  }
  return out;
}

export async function getMLBH2HNormalized({ limit = 3, offset = 0 } = {}) {
  const sportKey = "baseball_mlb";
  const market = "h2h";
  const list = await fetchEventIds(sportKey);
  const slice = (list || []).slice(offset, offset + limit);
  const out = [];
  for (const ev of slice) {
    const odds = await fetchOddsForEvent(sportKey, ev.id, market);
    const norm = normalizeH2HFromEventOdds(odds, { sport: "mlb", market: "MLB H2H" });
    if (norm) out.push(norm);
  }
  return out;
}

export async function getNCAAFH2HNormalized({ limit = 3, offset = 0 } = {}) {
  const sportKey = "americanfootball_ncaaf";
  const market = "h2h";
  const list = await fetchEventIds(sportKey);
  const slice = (list || []).slice(offset, offset + limit);
  const out = [];
  for (const ev of slice) {
    const odds = await fetchOddsForEvent(sportKey, ev.id, market);
    const norm = normalizeH2HFromEventOdds(odds, { sport: "ncaaf", market: "NCAAF H2H" });
    if (norm) out.push(norm);
  }
  return out;
}

/* ================================ DIAGNOSTICS =============================== */
// Lists books per game, honoring limit via eventIds + per-event odds (predictable burn).
export async function diagListBooksForSport(sport, { limit = 3, offset = 0 } = {}) {
  let sportKey = null;
  let sportName = sport;

  if (sport === "nfl") sportKey = "americanfootball_nfl";
  else if (sport === "mlb") sportKey = "baseball_mlb";
  else if (sport === "ncaaf") sportKey = "americanfootball_ncaaf";
  else return [];

  const market = "h2h";
  const events = await fetchEventIds(sportKey);
  const slice = (events || []).slice(offset, offset + limit);

  const out = [];
  for (const ev of slice) {
    const odds = await fetchOddsForEvent(sportKey, ev.id, market);
    if (!odds) continue;
    out.push({
      id: ev.id,
      away: ev.away_team,
      home: ev.home_team,
      commence_time: ev.commence_time,
      books: Array.isArray(odds.bookmakers) ? odds.bookmakers.map(b => b.key) : [],
    });
  }
  return out;
}

/* ================================ UTIL (unused) ============================ */
function americanToDecimal(odds) {
  const n = Number(odds);
  if (!Number.isFinite(n)) return null;
  if (n > 0) return 1 + n / 100;
  if (n < 0) return 1 + 100 / Math.abs(n);
  return 1;
}
