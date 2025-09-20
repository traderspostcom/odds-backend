import { bestLinesAndMetrics } from "./odds_math.js";

const BASE = "https://api.the-odds-api.com/v4";

// simple in-memory cache so we don't spam the API
const cache = { nfl_h2h: { data: null, ts: 0 } };
const ttlMs = Number(process.env.CACHE_TTL_SECONDS || 30) * 1000;

async function fetchJSON(url) {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
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
      best: metrics.best,
      hold: metrics.hold,
      devig: metrics.devig
    };
    if (minHold == null || metrics.hold <= minHold) out.push(row);
  }
  return out;
}

// ========== Generic Helpers ==========

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

function americanToProb(odds) {
  const o = Number(odds);
  if (!Number.isFinite(o)) return null;
  return o > 0 ? 100 / (o + 100) : (-o) / ((-o) + 100);
}

// ===== BOOK CONFIG (aliases, allow-list, tie-break) =====
/* keep your BOOK_ALIASES, ALLOWED_BOOKS, BOOK_PRIORITY, prettyBookName, betterOf functions here */

// ===== normalizeGames =====
/* keep your normalizeGames function exactly as you pasted earlier */

// ------------- Per-sport normalized fetchers -------------

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

// ========== ADD fetchOddsAndNormalize (my helper) ==========

/** Convert American odds to decimal & implied % */
function fromAmerican(am) {
  const n = Number(am);
  if (!Number.isFinite(n) || n === 0) return { decimal: "", impliedPct: "" };
  const decimal = n > 0 ? (1 + n / 100) : (1 + 100 / Math.abs(n));
  const implied = n > 0 ? (100 / (n + 100)) : (Math.abs(n) / (Math.abs(n) + 100));
  return { decimal: Number(decimal.toFixed(4)), impliedPct: Number((implied * 100).toFixed(2)) };
}

function normalizeMarket(m) {
  const s = String(m || "").toLowerCase();
  if (["ml", "moneyline", "h2h"].includes(s)) return "h2h";
  if (["spread", "spreads", "ats"].includes(s)) return "spreads";
  if (["total", "totals", "o/u", "ou"].includes(s)) return "totals";
  return s || "h2h";
}

function pickOutcome(marketKey, outcomes, { team, side, spreadPoint, totalPoint }) {
  if (!Array.isArray(outcomes) || outcomes.length === 0) return null;
  const byName = (name) =>
    outcomes.find((o) => String(o?.name || "").toLowerCase() === String(name || "").toLowerCase());

  const nearestByPoint = (flt, want) => {
    const arr = outcomes.filter(flt);
    if (!arr.length) return null;
    if (want == null) return arr[0];
    let best = null;
    let bestDiff = Infinity;
    for (const o of arr) {
      const p = Number(o?.point);
      if (!Number.isFinite(p)) continue;
      const diff = Math.abs(p - want);
      if (diff < bestDiff) {
        best = o;
        bestDiff = diff;
      }
    }
    return best || arr[0];
  };

  if (marketKey === "h2h") return team ? byName(team) || outcomes[0] : outcomes[0];

  if (marketKey === "spreads") {
    const teamLower = String(team || "").toLowerCase();
    return nearestByPoint((o) => String(o?.name || "").toLowerCase() === teamLower, Number(spreadPoint));
  }

  if (marketKey === "totals") {
    const wantedSide = String(side || "").toLowerCase().startsWith("u") ? "under" : "over";
    return nearestByPoint((o) => String(o?.name || "").toLowerCase() === wantedSide, Number(totalPoint));
  }

  return outcomes[0];
}

export async function fetchOddsAndNormalize({
  sportKey, market="h2h", team, side, spreadPoint, totalPoint, books=[], line
}) {
  let best = null;

  if (line) {
    const { decimal, impliedPct } = fromAmerican(line);
    best = { book: null, american: String(line), decimal, impliedPct };
  }

  const marketKey = normalizeMarket(market);
  if (ODDS_API_KEY && sportKey && Array.isArray(books) && books.length) {
    try {
      const url = new URL(`${ODDS_API_BASE}/sports/${sportKey}/odds/`);
      url.searchParams.set("regions", "us");
      url.searchParams.set("markets", marketKey);
      url.searchParams.set("oddsFormat", "american");
      url.searchParams.set("bookmakers", books.join(","));
      url.searchParams.set("apiKey", ODDS_API_KEY);

      const r = await fetch(url);
      if (r.ok) {
        const events = await r.json();
        const teamLower = String(team || "").toLowerCase();
        const ev =
          (teamLower
            ? events.find(
                (e) =>
                  (e.home_team || "").toLowerCase().includes(teamLower) ||
                  (e.away_team || "").toLowerCase().includes(teamLower)
              )
            : events[0]) || events[0];

        if (ev && Array.isArray(ev.bookmakers)) {
          for (const b of ev.bookmakers) {
            const mk = (b.markets || []).find(
              (m) => String(m?.key || "").toLowerCase() === marketKey
            );
            if (!mk) continue;

            const outcome = pickOutcome(marketKey, mk.outcomes, {
              team, side, spreadPoint, totalPoint
            });
            const american = outcome?.price;
            if (american == null) continue;

            const { decimal, impliedPct } = fromAmerican(american);
            if (!best || decimal > best.decimal) {
              best = {
                book: b.key,
                american: String(american),
                decimal,
                impliedPct,
                pickedPoint: outcome?.point,
              };
            }
          }
        }
      }
    } catch (err) {
      console.warn("Odds fetch failed:", err?.message || err);
    }
  }

  const out = {};
  if (best) {
    if (best.book) out["Book"] = best.book;
    out["Odds (Am)"] = best.american;
    out["Decimal"] = best.decimal;
    out["Implied %"] = best.impliedPct + "%";
    if (marketKey !== "h2h" && best.pickedPoint != null) out["Point"] = best.pickedPoint;
  }
  return out;
}
