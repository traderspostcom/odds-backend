// src/fetchers.js
const ODDS_BASE = "https://api.the-odds-api.com/v4";

const getRegion = () =>
  (process.env.ODDS_API_REGION || "us")
    .split(",").map(s => s.trim()).filter(Boolean).join(",");

const getBooksWhitelist = () =>
  (process.env.BOOKS_WHITELIST || "pinnacle,draftkings,betmgm,fanduel,caesars,bet365")
    .split(",").map(s => s.trim()).filter(Boolean);

async function fetchOdds(sportKey, market, extra = {}) {
  if (String(process.env.ODDS_API_ENABLED || "true").toLowerCase() !== "true") return [];
  const apiKey = process.env.ODDS_API_KEY;
  if (!apiKey) return [];

  const params = new URLSearchParams({
    apiKey,
    regions: getRegion(),
    markets: market,          // e.g., "h2h"
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

  const booksAllowed = getBooksWhitelist();
  const max = Number(process.env.MAX_EVENTS_PER_CALL || 3);

  return data
    .map((g) => {
      const books = Array.isArray(g.bookmakers)
        ? g.bookmakers
            .filter(bm => booksAllowed.includes(bm.key))
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

function americanToDecimal(odds) {
  const n = Number(odds);
  if (!Number.isFinite(n)) return null;
  if (n > 0) return 1 + n / 100;
  if (n < 0) return 1 + 100 / Math.abs(n);
  return 1;
}

function normalizeH2H(rawGames, { sport, market } = {}) {
  if (!Array.isArray(rawGames)) return [];

  return rawGames.map((g) => {
    const homeName = g.home || g.home_team;
    const awayName = g.away || g.away_team;

    // Aggregate one offer per BOOK with both sides nested under prices.home/away
    const offersByBook = new Map();

    for (const bm of g.bookmakers || []) {
      const bookKey = String(bm.key || "").toLowerCase();
      if (!bookKey) continue;

      // Ensure entry exists
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

          // Map team → side using exact team names from the game
          if (team === homeName) {
            entry.prices.home.american = price;
          } else if (team === awayName) {
            entry.prices.away.american = price;
          }
        }
      }
    }

    // Flatten, keep only books that have at least one side priced
    const offers = Array.from(offersByBook.values()).filter(o =>
      Number.isFinite(Number(o.prices.home.american)) ||
      Number.isFinite(Number(o.prices.away.american))
    );

    return {
      // analyzer expects these top-level fields:
      id: g.id,
      gameId: g.id,
      sport,
      market,
      home: homeName,
      away: awayName,
      commence_time: g.commence_time,

      // keep the old game block for debugging/compat
      game: { away: awayName, home: homeName, start_time_utc: g.commence_time },

      // analyzer-consumable offers
      offers,

      // provenance
      source_meta: { sport_key: g.sport_key, fetched_at: new Date().toISOString() },
    };
  });
}

// -------------------- Sport/market fetchers --------------------

export async function getNFLH2HNormalized({ limit = 3 } = {}) {
  const raw = await fetchOdds("americanfootball_nfl", "h2h");
  return normalizeH2H(raw, { sport: "nfl", market: "NFL H2H" }).slice(0, limit);
}

export async function getMLBH2HNormalized({ limit = 3 } = {}) {
  const raw = await fetchOdds("baseball_mlb", "h2h");
  return normalizeH2H(raw, { sport: "mlb", market: "MLB H2H" }).slice(0, limit);
}

export async function getNCAAFH2HNormalized({ limit = 3 } = {}) {
  const raw = await fetchOdds("americanfootball_ncaaf", "h2h");
  return normalizeH2H(raw, { sport: "ncaaf", market: "NCAAF H2H" }).slice(0, limit);
}

// -------------------- Diagnostics --------------------
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
