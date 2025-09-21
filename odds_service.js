// odds_service.js
const ODDS_API_BASE = process.env.ODDS_API_BASE || "https://api.the-odds-api.com/v4";
const ODDS_API_KEY = process.env.ODDS_API_KEY;

/* =============== Helpers =============== */
function americanToProb(odds) {
  const o = Number(odds);
  if (!Number.isFinite(o)) return null;
  return o > 0 ? 100 / (o + 100) : (-o) / ((-o) + 100);
}

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

/* =============== Fetch Odds =============== */
async function fetchOdds(sportKey, marketKey) {
  if (!ODDS_API_KEY) throw new Error("Missing ODDS_API_KEY env var");

  const url =
    `${ODDS_API_BASE}/sports/${sportKey}/odds/?` +
    `apiKey=${encodeURIComponent(ODDS_API_KEY)}&regions=us,uk,eu&markets=${marketKey}&oddsFormat=american&dateFormat=iso`;

  const resp = await fetch(url);
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Odds API ${resp.status} ${resp.statusText} – ${text}`);
  }
  return resp.json();
}

/* =============== Normalizer =============== */
function normalizeGames(games, marketKey, { minHold } = {}) {
  const out = [];

  for (const g of games || []) {
    const home = g.home_team;
    const away = g.away_team || (g.teams ? g.teams.find((t) => t !== home) : null);
    if (!home || !away) continue;

    let sideA = null;
    let sideB = null;

    for (const bk of g.bookmakers || []) {
      const key = (bk.key || "").toLowerCase();
      if (!ALLOWED_BOOKS.has(key)) continue;

      const label = prettyBookName(key, bk.title);
      const m = (bk.markets || []).find((m) => m.key === marketKey);
      if (!m) continue;

      if (marketKey.startsWith("h2h")) {
        const awayOutcome = m.outcomes.find((o) => o.name === away);
        const homeOutcome = m.outcomes.find((o) => o.name === home);
        if (awayOutcome) sideA = betterOf(sideA, { key, book: label, price: Number(awayOutcome.price) });
        if (homeOutcome) sideB = betterOf(sideB, { key, book: label, price: Number(homeOutcome.price) });
      }

      if (marketKey.includes("spreads")) {
        for (const o of m.outcomes) {
          if (o.name === away) sideA = betterOf(sideA, { key, book: label, price: Number(o.price), point: o.point });
          if (o.name === home) sideB = betterOf(sideB, { key, book: label, price: Number(o.price), point: o.point });
        }
      }

      if (marketKey.includes("totals")) {
        for (const o of m.outcomes) {
          const side = o.name.toLowerCase();
          if (side === "over") sideA = betterOf(sideA, { key, book: label, price: Number(o.price), point: o.point });
          if (side === "under") sideB = betterOf(sideB, { key, book: label, price: Number(o.price), point: o.point });
        }
      }
    }

    if (!sideA || !sideB) continue;

    const pA = americanToProb(sideA.price);
    const pB = americanToProb(sideB.price);
    if (pA == null || pB == null) continue;

    const hold = pA + pB - 1;
    if (typeof minHold === "number" && hold > minHold) continue;

    const sum = pA + pB || 1;
    const devigA = pA / sum;
    const devigB = pB / sum;

    let best;
    if (marketKey.startsWith("h2h")) best = { home: sideB, away: sideA };
    if (marketKey.includes("spreads")) best = { FAV: sideB, DOG: sideA };
    if (marketKey.includes("totals")) best = { O: sideA, U: sideB };

    out.push({
      gameId: g.id,
      commence_time: g.commence_time,
      home,
      away,
      market: marketKey,
      hold,
      devig: best,
      best
    });
  }

  out.sort((a, b) => (a.hold ?? 0) - (b.hold ?? 0));
  return out;
}

/* =============== Exports =============== */
// NFL
export async function getNFLH2HNormalized(opts) {
  const games = await fetchOdds("americanfootball_nfl", "h2h");
  return normalizeGames(games, "h2h", opts);
}
export async function getNFLSpreadsNormalized(opts) {
  const games = await fetchOdds("americanfootball_nfl", "spreads");
  return normalizeGames(games, "spreads", opts);
}
export async function getNFLTotalsNormalized(opts) {
  const games = await fetchOdds("americanfootball_nfl", "totals");
  return normalizeGames(games, "totals", opts);
}

// MLB
export async function getMLBH2HNormalized(opts) {
  const games = await fetchOdds("baseball_mlb", "h2h");
  return normalizeGames(games, "h2h", opts);
}
export async function getMLBSpreadsNormalized(opts) {
  const games = await fetchOdds("baseball_mlb", "spreads");
  return normalizeGames(games, "spreads", opts);
}
export async function getMLBTotalsNormalized(opts) {
  const games = await fetchOdds("baseball_mlb", "totals");
  return normalizeGames(games, "totals", opts);
}
// MLB First 5 — patched with all aliases
export async function getMLBF5Normalized(opts) {
  const keys = [
    "h2h_1st_5_innings",
    "h2h_1st_half",
    "1st_half",
    "first_5_innings"
  ];
  let allGames = [];

  for (const k of keys) {
    try {
      const games = await fetchOdds("baseball_mlb", k);
      if (Array.isArray(games) && games.length) {
        const normalized = normalizeGames(games, k, opts);
        allGames = allGames.concat(normalized);
      }
    } catch (err) {
      console.error(`⚠️ Error fetching MLB F5 for key=${k}:`, err.message);
    }
  }

  allGames.sort((a, b) => (a.hold ?? 0) - (b.hold ?? 0));
  return allGames;
}
// MLB F5 Totals
export async function getMLBF5TotalsNormalized(opts) {
  const games = await fetchOdds("baseball_mlb", "totals_1st_5_innings");
  return normalizeGames(games, "totals_1st_5_innings", opts);
}
// MLB Team Totals
export async function getMLBTeamTotalsNormalized(opts) {
  const games = await fetchOdds("baseball_mlb", "team_totals");
  return normalizeGames(games, "team_totals", opts);
}
// MLB Alt Lines
export async function getMLBAltLinesNormalized(opts) {
  const games = await fetchOdds("baseball_mlb", "alt_spreads");
  return normalizeGames(games, "alt_spreads", opts);
}

// NBA
export async function getNBAH2HNormalized(opts) {
  const games = await fetchOdds("basketball_nba", "h2h");
  return normalizeGames(games, "h2h", opts);
}
export async function getNBASpreadsNormalized(opts) {
  const games = await fetchOdds("basketball_nba", "spreads");
  return normalizeGames(games, "spreads", opts);
}
export async function getNBATotalsNormalized(opts) {
  const games = await fetchOdds("basketball_nba", "totals");
  return normalizeGames(games, "totals", opts);
}

// NCAAF
export async function getNCAAFH2HNormalized(opts) {
  const games = await fetchOdds("americanfootball_ncaaf", "h2h");
  return normalizeGames(games, "h2h", opts);
}
export async function getNCAAFSpreadsNormalized(opts) {
  const games = await fetchOdds("americanfootball_ncaaf", "spreads");
  return normalizeGames(games, "spreads", opts);
}
export async function getNCAAFTotalsNormalized(opts) {
  const games = await fetchOdds("americanfootball_ncaaf", "totals");
  return normalizeGames(games, "totals", opts);
}

// NCAAB
export async function getNCAABH2HNormalized(opts) {
  const games = await fetchOdds("basketball_ncaab", "h2h");
  return normalizeGames(games, "h2h", opts);
}
export async function getNCAABSpreadsNormalized(opts) {
  const games = await fetchOdds("basketball_ncaab", "spreads");
  return normalizeGames(games, "spreads", opts);
}
export async function getNCAABTotalsNormalized(opts) {
  const games = await fetchOdds("basketball_ncaab", "totals");
  return normalizeGames(games, "totals", opts);
}

// Tennis
export async function getTennisH2HNormalized(opts) {
  const games = await fetchOdds("tennis_atp", "h2h");
  return normalizeGames(games, "h2h", opts);
}

// Soccer
export async function getSoccerH2HNormalized(opts) {
  const games = await fetchOdds("soccer_usa_mls", "h2h");
  return normalizeGames(games, "h2h", opts);
}

// Generic Props
export async function getPropsNormalized(sportKey, marketKey, opts) {
  const games = await fetchOdds(sportKey, marketKey);
  return normalizeGames(games, marketKey, opts);
}
