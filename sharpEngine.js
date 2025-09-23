// sharpEngine.js (root)
// Hybrid analyzer: Splits → EV → Outlier, with optional dedupe bypass for testing.
// This version adds dynamic verdicts, Kelly, Play-to, Edge% for the EV path (per Russ spec).
// Outlier path is unchanged (we’ll upgrade it next after you confirm this is stable).

import fs from "fs";

/* ============================== ENV / KNOBS =============================== */
const DIAG = envBool("DIAG", true);

// EV thresholds (fractions used elsewhere; legacy keep)
const LEAN_THRESHOLD   = envNum("LEAN_THRESHOLD", 0.010); // 1.0%
const STRONG_THRESHOLD = envNum("STRONG_THRESHOLD", 0.020); // 2.0%

// Outlier thresholds (price advantage vs market median, in “cents”)
const OUT_DOG_LEAN   = envInt("OUTLIER_DOG_CENTS_LEAN", 10);
const OUT_DOG_STRONG = envInt("OUTLIER_DOG_CENTS_STRONG", 18);
const OUT_FAV_LEAN   = envInt("OUTLIER_FAV_CENTS_LEAN", 7);
const OUT_FAV_STRONG = envInt("OUTLIER_FAV_CENTS_STRONG", 12);

// Books to alert on. Supports "*" meaning "any".
const RAW_ALERT_BOOKS = (process.env.ALERT_BOOKS || "pinnacle")
  .split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
const ALERT_ALL   = RAW_ALERT_BOOKS.includes("*");
const ALERT_BOOKS = RAW_ALERT_BOOKS.filter(b => b !== "*");

// Simple re-alert state (cooldown 30m)
const STATE_FILE = process.env.SHARP_STATE_FILE || "./sharp_state.json";
let STATE = {};
try { if (fs.existsSync(STATE_FILE)) STATE = JSON.parse(fs.readFileSync(STATE_FILE, "utf8") || "{}"); }
catch { STATE = {}; }
function saveState() { try { fs.writeFileSync(STATE_FILE, JSON.stringify(STATE, null, 2)); } catch {} }

/* ================================= EXPORT ================================= */
export function analyzeMarket(snapshot, opts = {}) {
  if (!snapshot || typeof snapshot !== "object") return null;
  const bypassDedupe = !!opts.bypassDedupe;

  // Normalize top-level fields
  const sport   = (snapshot.sport || snapshot?.game?.sport || "").toLowerCase();
  const market  = snapshot.market || "";
  const gameId  = snapshot.gameId || snapshot.id || `${snapshot?.game?.home}-${snapshot?.game?.away}-${market}`;
  const home    = snapshot.home || snapshot?.game?.home;
  const away    = snapshot.away || snapshot?.game?.away;
  const commence_time = snapshot.commence_time || snapshot?.game?.start_time_utc || null;

  // 1) Splits path (if available)
  if (hasSplits(snapshot)) {
    const a = analyzeWithSplits(snapshot, { sport, market, gameId, home, away, commence_time }, { bypassDedupe });
    if (a) return a;
  }

  // 2) EV / Outlier paths
  const offers = normalizeOffers(snapshot); // per-book {book, home, away, last_update}
  if (offers.length < 2) {
    diag(() => console.log(`diag[ANZ] ${away} @ ${home} | offers=${offers.length} (need ≥2)`));
    return null;
  }

  const all = offers;
  const target    = ALERT_ALL ? all : all.filter(o => ALERT_BOOKS.includes(o.book));
  const nonTarget = ALERT_ALL ? all : all.filter(o => !ALERT_BOOKS.includes(o.book));
  if (!target.length) {
    diag(() => console.log(`diag[ANZ] ${away} @ ${home} | no target offers in [${ALERT_BOOKS.join(",")}]`));
    return null;
  }

  // EV path (UPGRADED)
  const evA = analyzeWithEV(all, target, nonTarget, { sport, market, gameId, home, away, commence_time }, { bypassDedupe });
  if (evA) return evA;

  // Outlier path (legacy behavior)
  const out = analyzeWithOutliers(all, target, { sport, market, gameId, home, away, commence_time }, { bypassDedupe });
  if (out) return out;

  return null;
}

/* =============================== SPLITS PATH ============================== */
function analyzeWithSplits(s, meta, { bypassDedupe }) {
  const tickets = num(s.tickets);
  const handle  = num(s.handle);
  const hold    = num(s.hold, null);
  if (!isFiniteNum(tickets) || !isFiniteNum(handle)) return null;

  const tPct = tickets > 1 ? tickets : tickets * 100;
  const hPct = handle  > 1 ? handle  : handle  * 100;
  const gapPct = hPct - tPct;

  const rules = { maxTicketsPct: 45, minHandlePct: 55, minGap: 10, maxHold: 7, prefHold: 5 };
  if (tPct > rules.maxTicketsPct) return null;
  if (hPct < rules.minHandlePct)  return null;
  if (gapPct < rules.minGap)      return null;
  if (hold != null && hold > rules.maxHold / 100) return null;

  let score = 0;
  if (gapPct >= rules.minGap) score += 2;
  if (hold == null || hold <= rules.prefHold / 100) score += 1;

  const tier = score >= 3 ? "strong" : score >= 2 ? "lean" : "pass";
  if (tier === "pass") return null;

  const side = s.side || (hPct >= tPct ? "home" : "away");
  const team = side === "home" ? meta.home : meta.away;
  const line = s.line ?? null;

  return finalizeAlert({
    ...meta,
    source: "splits",
    score, tier, side, team,
    entryLine: line, priceBook: null, evPct: null,
    signals: [
      { key: "split_gap", label: `Handle > Tickets by ${Math.round(gapPct)}%`, weight: 2 },
      ...(hold != null ? [{ key: "hold", label: `Hold ${Math.round(hold * 100)}%`, weight: 1 }] : []),
    ],
    bypassDedupe,
  });
}

/* ================================ EV PATH ================================= */
/** Build fair from consensus (exclude candidate book where possible), then
 *  compute EV, Edge, Kelly, Play-to, Verdict (dynamic by sport + time).
 */
function analyzeWithEV(all, target, nonTarget, meta, { bypassDedupe }) {
  let best = null;

  for (const o of target) {
    // consensus excluding candidate book; if empty, fall back to nonTarget or all
    let consensusPool = all.filter(x => x.book !== o.book);
    if (!consensusPool.length) consensusPool = nonTarget.length ? nonTarget : all;

    const fair = buildFairFrom(consensusPool);
    if (!fair) continue;

    if (isFiniteNum(o.home)) {
      const evH = evFromFair(o.home, fair.pHome); // fractional
      if (!best || evH > best.evPct) best = { side: "home", price: o.home, book: o.book, evPct: evH, fairN: fair.n, fairPH: fair.pHome };
    }
    if (isFiniteNum(o.away)) {
      const evA = evFromFair(o.away, 1 - fair.pHome);
      if (!best || evA > best.evPct) best = { side: "away", price: o.away, book: o.book, evPct: evA, fairN: fair.n, fairPH: fair.pHome };
    }
  }

  if (!best) return null;

  // model prob for picked side
  const pModel = best.side === "home" ? best.fairPH : (1 - best.fairPH);
  const evFrac = best.evPct; // 0.012 = 1.2%
  const edgePct = (pModel - impliedProbAmerican(best.price)) * 100;
  const minutes = minutesToPost(meta.commence_time);
  const kellyRawPct = kellyFrac(best.price, pModel) * 100;
  const cap = sportCapPct(meta.sport);
  const kellyHalfPct = Math.min(cap, kellyRawPct / 2);

  // Dynamic verdict by sport + time
  const verdict = decideVerdict({ sport: meta.sport, minutes, edgePct, evPct: evFrac * 100, kellyPct: kellyRawPct });

  // Global floor to avoid noise
  if (verdict === "pass" || evFrac * 100 < 0.25) {
    diag(() => console.log(`diag[EV] ${meta.away} @ ${meta.home} | pass edge=${edgePct.toFixed(2)} ev=${(evFrac*100).toFixed(2)} kelly=${kellyRawPct.toFixed(2)}`));
    return null;
  }

  const team = best.side === "home" ? meta.home : meta.away;

  // Play-to (EV=0) exact & rounded
  const playTo = playToFromProb(pModel);

  // Map verdict -> legacy tier (keep downstream formatting stable)
  const tier = verdict === "strong" ? "strong" : "lean";

  return finalizeAlert({
    ...meta,
    source: "ev",
    score: Math.round(evFrac * 10000) / 100, // preserve prior score style (EV%)
    tier, side: best.side, team,
    entryLine: best.price, priceBook: best.book, evPct: evFrac,
    signals: [
      { key: "consensus_n", label: `Consensus N=${best.fairN}`, weight: 1 },
      { key: "fair_home",   label: `Fair(Home) ${(best.fairPH*100).toFixed(1)}%`, weight: 1 },
      { key: "edge_pct",    label: `Edge ${edgePct.toFixed(2)}%`, weight: 2 },
      { key: "ev_pct",      label: `+${(evFrac*100).toFixed(2)}% EV`, weight: 2 },
      { key: "kelly",       label: `Kelly ${kellyRawPct.toFixed(1)}% / ½ ${kellyHalfPct.toFixed(1)}% (cap ${cap.toFixed(1)}%)`, weight: 1 },
      ...(playTo ? [{ key: "play_to", label: `Play-to ${playTo.exact} / ${playTo.rounded}`, weight: 1 }] : []),
      { key: "book",        label: `Book ${best.book}`, weight: 1 },
      { key: "verdict",     label: `Verdict ${verdict.toUpperCase()}`, weight: 2 },
      { key: "t2p",         label: `T-${minutes}m`, weight: 1 },
    ],
    bypassDedupe,
  });
}

/* =============================== OUTLIER PATH ============================== */
// (Legacy behavior kept; we’ll enhance with same verdict/gates in next step.)
function analyzeWithOutliers(all, target, meta, { bypassDedupe }) {
  let best = null;

  for (const o of target) {
    const others = all.filter(x => x.book !== o.book);
    if (!others.length) continue;

    const medHome = median(others.map(x => x.home).filter(isFiniteNum));
    const medAway = median(others.map(x => x.away).filter(isFiniteNum));

    if (isFiniteNum(o.home) && isFiniteNum(medHome)) {
      const diff = o.home - medHome;
      const isDog = o.home >= 0;
      const leanGate = isDog ? OUT_DOG_LEAN : OUT_FAV_LEAN;
      const strongGate = isDog ? OUT_DOG_STRONG : OUT_FAV_STRONG;
      let tier = null; if (diff >= strongGate) tier = "strong"; else if (diff >= leanGate) tier = "lean";
      if (tier) {
        const s = { side: "home", price: o.home, book: o.book, diff, tier, med: medHome, othersN: others.length };
        if (!best || rankTier(s.tier) > rankTier(best.tier) || s.diff > best.diff) best = s;
      }
    }

    if (isFiniteNum(o.away) && isFiniteNum(medAway)) {
      const diff = o.away - medAway;
      const isDog = o.away >= 0;
      const leanGate = isDog ? OUT_DOG_LEAN : OUT_FAV_LEAN;
      const strongGate = isDog ? OUT_DOG_STRONG : OUT_FAV_STRONG;
      let tier = null; if (diff >= strongGate) tier = "strong"; else if (diff >= leanGate) tier = "lean";
      if (tier) {
        const s = { side: "away", price: o.away, book: o.book, diff, tier, med: medAway, othersN: others.length };
        if (!best || rankTier(s.tier) > rankTier(best.tier) || s.diff > best.diff) best = s;
      }
    }
  }

  if (!best) return null;

  const team = best.side === "home" ? meta.home : meta.away;
  return finalizeAlert({
    ...meta,
    source: "outlier",
    score: Math.round(best.diff),
    tier: best.tier, side: best.side, team,
    entryLine: best.price, priceBook: best.book, evPct: null,
    signals: [
      { key: "consensus_n", label: `Consensus N=${best.othersN}`, weight: 1 },
      { key: "median_ref",  label: `Median ${best.side.toUpperCase()} ${fmtAm(best.med)}`, weight: 1 },
      { key: "delta_cents", label: `+${Math.round(best.diff)}¢ vs market`, weight: 2 },
      { key: "book",        label: `Book ${best.book}`, weight: 1 },
    ],
    bypassDedupe,
  });
}

/* ============================= FAIR/EV HELPERS ============================ */
function buildFairFrom(consensusOffers) {
  const rows = [];
  for (const o of consensusOffers) {
    if (!isFiniteNum(o.home) || !isFiniteNum(o.away)) continue;
    const pH_raw = impliedFromAmerican(o.home);
    const pA_raw = impliedFromAmerican(o.away);
    const s = pH_raw + pA_raw; if (s <= 0) continue;
    const pH = pH_raw / s; // devig within book
    rows.push(pH);
  }
  if (!rows.length) return null;
  return { pHome: avg(rows), n: rows.length };
}

function evFromFair(american, fairP) {
  const dec = americanToDecimal(american);
  return fairP * (dec - 1) - (1 - fairP); // fractional EV per $1 stake
}

/* ================================= UTIL =================================== */
// Accepts either:
//  A) offers: [{book, team, american, decimal?, last_update?}, ...] + game.home/away
//  B) offers: [{book, prices: {home:{american}, away:{american}}}, ...]
function normalizeOffers(snap) {
  const out = [];
  const perBook = new Map();

  const homeName = snap.home || snap?.game?.home;
  const awayName = snap.away || snap?.game?.away;

  for (const o of snap?.offers || []) {
    const book = String(o.book || o.bookmaker || o.key || "").toLowerCase().trim();
    if (!book) continue;

    // shape A: flat team rows
    if (o.team && (o.american != null)) {
      const row = perBook.get(book) || { book, home: undefined, away: undefined, last_update: o.last_update || null };
      if (o.team === homeName) row.home = num(o.american, row.home);
      else if (o.team === awayName) row.away = num(o.american, row.away);
      // if last_update newer, keep it
      row.last_update = newerISO(row.last_update, o.last_update);
      perBook.set(book, row);
      continue;
    }

    // shape B: nested prices
    const home = num(o?.prices?.home?.american, undefined);
    const away = num(o?.prices?.away?.american, undefined);
    if (isFiniteNum(home) || isFiniteNum(away)) {
      perBook.set(book, {
        book, home, away,
        last_update: o.last_update || null
      });
    }
  }

  for (const row of perBook.values()) {
    if (isFiniteNum(row.home) && isFiniteNum(row.away)) {
      out.push({ book: row.book, home: row.home, away: row.away, last_update: row.last_update || null });
    }
  }
  return out;
}

function newerISO(prev, next) {
  if (!next) return prev || null;
  if (!prev) return next;
  const a = Date.parse(prev), b = Date.parse(next);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return prev;
  return b > a ? next : prev;
}

function hasSplits(s) { return typeof s?.tickets === "number" && typeof s?.handle === "number"; }

function americanToDecimal(a) { const n = Number(a); if (!Number.isFinite(n)) return NaN; return n > 0 ? 1 + n/100 : 1 + 100/Math.abs(n); }
function decimalToAmerican(d) { return d >= 2 ? Math.round((d - 1) * 100) : Math.round(-100 / (d - 1)); }
function impliedFromAmerican(a) { const n = Number(a); if (!Number.isFinite(n)) return NaN; return n > 0 ? 100/(n+100) : Math.abs(n)/(Math.abs(n)+100); }
function impliedProbAmerican(a) { return impliedFromAmerican(a); }

/* --------------------------- Alert Construction --------------------------- */
function finalizeAlert({
  sport, market, gameId, home, away, commence_time,
  source, score, tier, side, team, entryLine, priceBook, evPct, signals, bypassDedupe,
}) {
  const key = gameId || `${home}-${away}-${market}`;
  const now = Date.now();
  const prev = STATE[key];
  let allow = true;
  let type = bypassDedupe ? "forced" : "initial";

  if (!bypassDedupe && prev) {
    const cooldownMs = 30 * 60 * 1000;
    if (now - prev.ts < cooldownMs) {
      if (isFiniteNum(entryLine) && isFiniteNum(prev.entryLine)) {
        if (americanBetter(entryLine, prev.entryLine)) type = "realert_plus";
        else allow = false;
      } else {
        allow = false;
      }
    }
  }
  if (!allow) return null;

  // Persist (still update even on forced to keep state consistent)
  STATE[key] = { ts: now, entryLine: entryLine ?? null, side };
  saveState();

  const strengthEmoji = tier === "strong" ? "🟢 Strong" : "🟡 Lean";

  return {
    type, source, sport, market,
    game_id: key,
    game: { away, home, start_time_utc: commence_time },
    sharp_side: { side, team, confidence: tier },
    lines: { sharp_entry: entryLine ?? null, current_consensus: entryLine ?? null, direction: "flat", book: priceBook || null },
    score: score ?? null,
    signals: signals || [],
    render: {
      title: `SHARP ALERT – ${String(sport || "").toUpperCase()} ${away} @ ${home}`,
      emoji: type === "initial" ? "🚨" : type === "realert_plus" ? "🟢" : "🔁",
      strength: strengthEmoji,
      tags: [source.toUpperCase()],
    },
    meta: { generated_at: new Date().toISOString() },
  };
}

/* ------------------------------ Verdict Logic ----------------------------- */
// Time to post (minutes)
function minutesToPost(commence_time) {
  if (!commence_time) return 9999;
  const t = Date.parse(commence_time);
  if (!Number.isFinite(t)) return 9999;
  return Math.max(0, Math.round((t - Date.now()) / 60000));
}
function leagueBand(sport) {
  sport = String(sport || "").toLowerCase();
  if (sport === "nfl" || sport === "nba") return "NFL_NBA";
  if (sport === "mlb" || sport === "nhl") return "MLB_NHL";
  if (sport === "ncaaf" || sport === "ncaab" || sport === "wnba") return "NCAA_WNBA";
  return "MLB_NHL"; // default conservative
}
// base thresholds per band, then adjust by time to post
function verdictThresholds(sport, minutes) {
  const band = leagueBand(sport);
  let edgeS, evS, kellyS, edgeMmin, edgeMmax, evMmin, evMmax;
  if (band === "NFL_NBA") {
    edgeS=2.5; evS=1.0; kellyS=3.0; edgeMmin=1.2; edgeMmax=2.4; evMmin=0.3; evMmax=0.9;
  } else if (band === "MLB_NHL") {
    edgeS=3.0; evS=1.2; kellyS=4.0; edgeMmin=1.0; edgeMmax=2.9; evMmin=0.2; evMmax=1.1;
  } else { // NCAA_WNBA
    edgeS=3.0; evS=1.0; kellyS=3.0; edgeMmin=1.0; edgeMmax=2.9; evMmin=0.2; evMmax=0.9;
  }
  if (minutes >= 360) { // T-6h or more → loosen slightly
    edgeS -= 0.3; evS -= 0.2;
    edgeMmin = Math.max(0, edgeMmin - 0.3); evMmin = Math.max(0, evMmin - 0.2);
  } else if (minutes <= 60) { // last hour → tighten
    edgeS += 0.3; evS += 0.2;
    edgeMmin += 0.3; evMmin += 0.2;
  }
  return { edgeS, evS, kellyS, edgeMmin, edgeMmax, evMmin, evMmax };
}
function decideVerdict({ sport, minutes, edgePct, evPct, kellyPct }) {
  const T = verdictThresholds(sport, minutes);
  if (edgePct >= T.edgeS && evPct >= T.evS && kellyPct >= T.kellyS) return "strong";
  const edgeMed = edgePct >= T.edgeMmin && edgePct <= T.edgeMmax;
  const evMed   = evPct   >= T.evMmin   && evPct   <= T.evMmax;
  if (edgeMed || evMed) return "medium";
  return "pass";
}
function playToFromProb(pModel) {
  if (!Number.isFinite(pModel) || pModel <= 0 || pModel >= 1) return null;
  const dec = 1 / pModel;
  const amExact = decimalToAmerican(dec);
  const amRounded = roundConservative(amExact);
  return { exact: Math.round(amExact), rounded: amRounded };
}
function roundConservative(am) {
  const step = 5;
  if (am < 0) { // favorite: toward 0 (cheaper)
    const q = Math.trunc(Math.abs(am) / step);
    return -(q * step); // -141 -> -140
  } else {     // dog: down
    const q = Math.trunc(am / step);
    return q * step;    // +132 -> +130
  }
}
function kellyFrac(american, pModel) {
  const dec = americanToDecimal(american);
  const b = dec - 1;
  const p = pModel;
  if (!Number.isFinite(b) || b <= 0 || !Number.isFinite(p)) return 0;
  const k = (b * p - (1 - p)) / b;
  return Math.max(0, k);
}
function sportCapPct(sport) {
  const band = leagueBand(sport);
  if (band === "MLB_NHL") return 1.0; // per Russ: 1.0%
  return 2.0; // NFL/NBA/NCAAF/NCAAB/WNBA
}

/* --------------------------------- Helpers -------------------------------- */
function americanBetter(curr, prev) { if (!isFiniteNum(curr) || !isFiniteNum(prev)) return false; return curr > prev; }
function fmtAm(a) { return a >= 0 ? `+${a}` : `${a}`; }
function rankTier(t) { return t === "strong" ? 2 : 1; }
function avg(a){let s=0;for(const x of a)s+=x;return a.length?s/a.length:NaN;}
function median(a){const b=[...a].sort((x,y)=>x-y);const n=b.length;if(!n)return NaN;const m=Math.floor(n/2);return n%2?b[m]:(b[m-1]+b[m])/2;}
function isFiniteNum(x){return Number.isFinite(Number(x));}
function num(x,def=undefined){const n=Number(x);return Number.isFinite(n)?n:def;}
function envNum(k,def){const n=Number(process.env[k]);return Number.isFinite(n)?n:def;}
function envInt(k,def){const n=parseInt(process.env[k],10);return Number.isFinite(n)?n:def;}
function envBool(k,def){const v=process.env[k];if(v==null)return def;const s=String(v).toLowerCase();if(["1","true","yes","y"].includes(s))return true;if(["0","false","no","n"].includes(s))return false;return def;}
function diag(fn){ if (DIAG) { try { fn(); } catch {} } }
