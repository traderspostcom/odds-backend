// fetchers.js
// Safe Odds API fetchers + mappers (NFL H2H → snapshots with multi-book offers)

import { setTimeout as sleep } from "timers/promises";

/* -------------------------------------------------------------------------- */
/*  Env & knobs                                                                */
/* -------------------------------------------------------------------------- */
const ODDS_API_ENABLED = flag("ODDS_API_ENABLED", true);
const ODDS_API_KEY = process.env.ODDS_API_KEY || "";
const RATE_LIMIT_MS = num("RATE_LIMIT_MS", 1200);
const RETRY_429_MAX = num("RETRY_429_MAX", 0);

const DIAG = flag("DIAG", false);
const MAX_EVENTS_PER_CALL = num("MAX_EVENTS_PER_CALL", 3);
const REGION = (process.env.ODDS_API_REGION || "us").toLowerCase(); // 'us','us2','eu','uk','au'
const DATE_FMT = "iso";
const ODDS_FMT = "american";

// Build the list once and reuse both in-request (bookmakers param) and post-filter
const BOOKS_WHITELIST = (process.env.BOOKS_WHITELIST || "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

// Helper: alert only on these, but form consensus from many
const ALERT_BOOKS = (process.env.ALERT_BOOKS || "pinnacle")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

/* -------------------------------------------------------------------------- */
/*  Public API                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Fetch NFL H2H odds and return snapshots formatted for sharpEngine (EV path).
 * Each snapshot has: { sport, market, gameId, home, away, commence_time, offers[] }
 */
export async function fetchNFLH2H({ limit = 5 } = {}) {
  if (!ODDS_API_ENABLED) {
    diag(() => console.log("diag[fetchNFLH2H] provider gate OFF → []"));
    return [];
  }
  if (!ODDS_API_KEY) {
    warn("⚠️ ODDS_API_KEY missing; cannot call provider.");
    return [];
  }

  const sportKey = "americanfootball_nfl";
  const base = `https://api.the-odds-api.com/v4/sports/${sportKey}/odds`;

  const params = new URLSearchParams({
    regions: REGION,
    markets: "h2h",
    oddsFormat: ODDS_FMT,
    dateFormat: DATE_FMT,
    apiKey: ODDS_API_KEY,
  });

  // Limit provider response to whitelisted books if provided (saves credits)
  if (BOOKS_WHITELIST.length > 0) {
    params.set("bookmakers", BOOKS_WHITELIST.join(","));
  }

  const url = `${base}?${params.toString()}`;

  const data = await safeJsonGet(url);
  if (!Array.isArray(data) || data.length === 0) {
    diag(() => console.log("diag[fetchNFLH2H] empty payload"));
    return [];
  }

  // Map → snapshots
  const snapshots = [];
  let seen = 0;
  for (const ev of data) {
    if (seen >= Math.max(1, MAX_EVENTS_PER_CALL)) break;
    const snap = mapOddsEventToNFLH2HSnapshot(ev);
    if (snap) {
      snapshots.push(snap);
      seen++;
    }
  }

  // Respect the caller-visible limit
  const out = snapshots.slice(0, Math.max(1, limit));

  diag(() =>
    out.forEach((s) => {
      const books = uniqBooks(s.offers);
      console.log(
        `diag[fetchNFLH2H] ${s.away} @ ${s.home} | offers=${s.offers.length} | books=[${books.join(
          ", "
        )}] | alertBooks=[${ALERT_BOOKS.join(", ")}]`
      );
    })
  );

  // Light pacing between calls
  await sleep(RATE_LIMIT_MS);

  return out;
}

/* -------------------------------------------------------------------------- */
/*  Mapper: Odds API event → snapshot with offers[]                            */
/* -------------------------------------------------------------------------- */

export function mapOddsEventToNFLH2HSnapshot(ev) {
  try {
    const gameId = ev.id || ev.game_id || ev.event_id;
    const home = ev.home_team;
    const away = ev.away_team;
    const commence_time = ev.commence_time; // ISO 8601

    if (!home || !away || !Array.isArray(ev.bookmakers)) return null;

    const offers = [];
    for (const bm of ev.bookmakers) {
      const bookKey = norm(bm.key || bm.title);
      if (!bookKey) continue;
      if (BOOKS_WHITELIST.length > 0 && !BOOKS_WHITELIST.includes(bookKey)) {
        continue;
      }

      // Find the H2H market
      const h2h = (bm.markets || []).find(
        (m) => norm(m.key) === "h2h" || norm(m.market) === "h2h"
      );
      if (!h2h || !Array.isArray(h2h.outcomes)) continue;

      // Outcomes are named by team; match by exact (case-insensitive) name
      const oHome = findOutcomeByTeam(h2h.outcomes, home);
      const oAway = findOutcomeByTeam(h2h.outcomes, away);
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
      gameId,
      home,
      away,
      commence_time,
      offers, // critical for EV analyzer (needs ≥ 2)
    };
  } catch (e) {
    warn(`⚠️ mapOddsEventToNFLH2HSnapshot error: ${e?.message || e}`);
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/*  Utilities                                                                  */
/* -------------------------------------------------------------------------- */

function norm(x) {
  return typeof x === "string" ? x.toLowerCase().trim() : "";
}
function toAmerican(n) {
  if (n == null) return null;
  const numVal = Number(n);
  return Number.isFinite(numVal) ? numVal : null;
}
function findOutcomeByTeam(outcomes, teamName) {
  const t = (teamName || "").toLowerCase();
  return outcomes.find((o) => (o.name || "").toLowerCase() === t);
}
function uniqBooks(offers = []) {
  return Array.from(
    new Set(
      offers.map((o) => (o.book || o.bookmaker || "").toLowerCase()).filter(Boolean)
    )
  );
}
function headersJson() {
  return {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

// Safe fetch with minimal retries & rate limiting
async function safeJsonGet(url) {
  let attempt = 0;
  let lastErr;
  while (attempt <= Math.max(0, RETRY_429_MAX)) {
    try {
      const res = await fetch(url, {
        method: "GET",
        headers: headersJson(),
      });

      if (res.status === 429) {
        attempt++;
        const wait = RATE_LIMIT_MS * (attempt + 1);
        diag(() =>
          console.log(`diag[safeJsonGet] 429 from provider, backoff ${wait}ms (attempt ${attempt})`)
        );
        await sleep(wait);
        continue;
      }

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status} ${res.statusText} – ${text.slice(0, 180)}`);
      }

      return await res.json();
    } catch (e) {
      lastErr = e;
      break;
    }
  }
  warn(`⚠️ safeJsonGet failed: ${lastErr?.message || lastErr}`);
  return [];
}

/* -------------------------------------------------------------------------- */
/*  Tiny logging helpers                                                       */
/* -------------------------------------------------------------------------- */
function diag(fn) {
  if (DIAG) {
    try {
      fn();
    } catch {}
  }
}
function warn(msg) {
  try {
    console.warn(msg);
  } catch {}
}

/* -------------------------------------------------------------------------- */
/*  Small env helpers                                                          */
/* -------------------------------------------------------------------------- */
function flag(k, def = false) {
  const v = process.env[k];
  if (v == null) return def;
  const s = String(v).toLowerCase();
  if (["1", "true", "yes", "y"].includes(s)) return true;
  if (["0", "false", "no", "n"].includes(s)) return false;
  return def;
}
function num(k, def = 0) {
  const v = Number(process.env[k]);
  return Number.isFinite(v) ? v : def;
}

/* -------------------------------------------------------------------------- */
/*  Export shape expected by index.js                                          */
/* -------------------------------------------------------------------------- */
export const FETCHERS = {
  fetchNFLH2H,
  mapOddsEventToNFLH2HSnapshot,
};
