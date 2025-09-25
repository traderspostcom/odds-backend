// src/fetchers.js
// Minimal, env-driven fetchers. Regions and book lists come ONLY from env.

const ODDS_BASE = "https://api.the-odds-api.com/v4";

/* ----------------------------- ENV helpers ----------------------------- */

const getRegion = () => {
  // No defaults. If you forget to set this in Render, we pass empty and
  // the provider will likely error / return nothing (fail closed).
  const v = (process.env.ODDS_API_REGION || "").trim();
  if (!v) return "";
  return v.split(",").map(s => s.trim()).filter(Boolean).join(",");
};

const getBooksWhitelist = () => {
  // No defaults. Empty list = allow zero books (fail closed).
  const v = (process.env.BOOKS_WHITELIST || "").trim();
  if (!v) return [];
  return v.split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
};

const bool = (v, def = false) => {
  if (v == null) return def;
  const s = String(v).toLowerCase().trim();
  if (["1","true","yes","y"].includes(s)) return true;
  if (["0","false","no","n"].includes(s)) return false;
  return def;
};

/* -------------------------------- Fetch -------------------------------- */

async function fetchOdds(sportKey, market, extra = {}) {
  if (!bool(process.env.ODDS_API_ENABLED, true)) return [];
  const apiKey = process.env.ODDS_API_KEY;
  if (!apiKey) return [];

  const params = new URLSearchParams({
    apiKey,
    regions: getRegion(),       // e.g. "eu"
    markets: market,            // e.g., "h2h"
    oddsFormat: "american",
    dateFormat: "iso",
  });
  for (const [k, v] of Object.entries(extra)) {
    if (v !== undefined && v !== null && v !== "") params.set(k, String(v));
  }

  const url = `${ODDS_BASE}/sports/${sportKey}/odds?${params.toString()}`;
  const res = await fetch(url);
  if (!res.ok) return [];
  const data = await res.json();
  if (!Array.isArray(data)) return [];

  const booksAllowed = getBooksWhitelist(); // env-driven only
  const max = Number(process.env.MAX_EVENTS_PER_CALL || 3);

  return data
    .map((g) => {
      const books = Array.isArray(g.bookmakers)
        ? g.bookmakers
            .filter(bm => booksAllowed.includes(String(bm.key || "").toLowerCase()))
            .map(bm => ({
              key: bm.key,
              title: bm.title,
              last_update: bm.last_update,
              markets: bm.markets || [],
            }))
        : [];
      return {
        id: g.id,
        sport_key: g.sport_key,
        commence_time: g.commence_time,
        home: g.home_team,
        away: g.away_team,
        bookmakers: books,
      };
    })
    .slice(0, max);
}

function normalizeH2H(rawGames, { sport, market } = {}) {
  if (!Array.isArray(rawGames)) return [];

  return rawGames.map((g) => {
    const homeName = g.home || g.home_team;
    const awayName = g.away || g.away_team;

    // one row per book with both sides under prices.home/away
    const offersByBook = new Map();

    for (const bm of g.bookmakers || []) {
      const bookKey = String(bm.key || "").toLowerCase();
      if (!bookKey) continue;

      if (!offersByBook.has(bookKey)) {
        offersByBook.set(bookKey, {
          book: bookKey,
          prices: { home: { american: undefined }, away: { american: undefined } },
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

          if (team === homeName)      entry.prices.home.american = price;
          else if (team === awayName) entry.prices.away.american = price;
        }
      }
    }

    const offers = Array.from(offersByBook.values()).filter(o =>
      Number.isFinite(Number(o.prices.home.american)) ||
      Number.isFinite(Number(o.prices.away.american))
    );

    return {
      id: g.id,
      gameId: g.id,
      sport,
      market,
      home: homeName,
      away: awayName,
      commence_time: g.commence_time,

      game: { away: awayName, home: homeName, start_time_utc: g.commence_time },

      offers,

      source_meta: { sport_key: g.sport_key, fetched_at: new Date().toISOString() },
    };
  });
}

/* -------------------- Sport/market fetchers (offset-aware) -------------------- */

export async function getNFLH2HNormalized({ limit = 3, offset = 0 } = {}) {
  const raw = await fetchOdds("americanfootball_nfl", "h2h");
  return normalizeH2H(raw, { sport: "nfl", market: "NFL H2H" })
    .slice(offset, offset + limit);
}

export async function getMLBH2HNormalized({ limit = 3, offset = 0 } = {}) {
  const raw = await fetchOdds("baseball_mlb", "h2h");
  return normalizeH2H(raw, { sport: "mlb", market: "MLB H2H" })
    .slice(offset, offset + limit);
}

export async function getNCAAFH2HNormalized({ limit = 3, offset = 0 } = {}) {
  const raw = await fetchOdds("americanfootball_ncaaf", "h2h");
  return normalizeH2H(raw, { sport: "ncaaf", market: "NCAAF H2H" })
    .slice(offset, offset + limit);
}

/* -------------------- Diagnostics -------------------- */

export async function diagListBooksForSport(sport, { limit = 3 } = {}) {
  let raw = [];
  if (sport === "nfl") {
    raw = await fetchOdds("americanfootball_nfl", "h2h");
  } else if (sport === "mlb") {
    raw = await fetchOdds("baseball_mlb", "h2h");
  } else if (sport === "ncaaf") {
    raw = await fetchOdds("americanfootball_ncaaf", "h2h");
  } else {
    return [];
  }

  return raw.slice(0, limit).map(g => ({
    id: g.id,
    away: g.away_team || g.away,
    home: g.home_team || g.home,
    commence_time: g.commence_time,
    books: Array.isArray(g.bookmakers) ? g.bookmakers.map(b => b.key) : [],
  }));
}
