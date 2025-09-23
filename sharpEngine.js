// sharpEngine.js (root)
// Hybrid analyzer: use SPLITS if available, else EV fallback from multi-book offers.
// Env-driven (no config import). Supports ALERT_BOOKS="*" and per-book consensus exclusion.
// Exports: analyzeMarket(snapshot)

import fs from "fs";

/* ============================== ENV / KNOBS =============================== */
// Logging
const DIAG = envBool("DIAG", true);

// EV thresholds (fractions: 0.01 = 1%)
const LEAN_THRESHOLD   = envNum("LEAN_THRESHOLD", 0.005);  // 0.5% default
const STRONG_THRESHOLD = envNum("STRONG_THRESHOLD", 0.010); // 1.0% default

// Books to alert on. Supports "*" meaning "any".
const RAW_ALERT_BOOKS = (process.env.ALERT_BOOKS || "pinnacle")
  .split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
const ALERT_ALL   = RAW_ALERT_BOOKS.includes("*");
const ALERT_BOOKS = RAW_ALERT_BOOKS.filter(b => b !== "*");

// Simple re-alert / dedupe state (per gameId)
const STATE_FILE = process.env.SHARP_STATE_FILE || "./sharp_state.json";
let STATE = {};
try {
  if (fs.existsSync(STATE_FILE)) STATE = JSON.parse(fs.readFileSync(STATE_FILE, "utf8") || "{}");
} catch { STATE = {}; }
function saveState() {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(STATE, null, 2)); }
  catch (e) { console.warn("⚠️ Could not persist sharp state:", e?.message || e); }
}

/* ================================ EXPORT ================================== */
export function analyzeMarket(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return null;

  const sport = snapshot.sport || "";
  const market = snapshot.market || "";
  const gameId = snapshot.gameId || `${snapshot.home}-${snapshot.away}-${market}`;
  const home = snapshot.home;
  const away = snapshot.away;
  const commence_time = snapshot.commence_time || null;

  // 1) Splits path (tickets/handle present)
  if (hasSplits(snapshot)) {
    const a = analyzeWithSplits(snapshot, { sport, market, gameId, home, away, commence_time });
    if (a) return a;
  }

  // 2) EV fallback path (needs ≥2 distinct books)
  const offers = normalizeOffers(snapshot);
  if (offers.length < 2) {
    diag(() => console.log(`diag[EV] ${away} @ ${home} | offers=${offers.length} (need ≥2)`));
    return null;
  }

  return analyzeWithEV(offers, { sport, market, gameId, home, away, commence_time });
}

/* =============================== SPLITS PATH ============================== */
function analyzeWithSplits(s, meta) {
  const tickets = num(s.tickets);
  const handle  = num(s.handle);
  const hold    = num(s.hold, null);
  if (!isFiniteNum(tickets) || !isFiniteNum(handle)) return null;

  // Normalize to 0..100
  const tPct = tickets > 1 ? tickets : tickets * 100;
  const hPct = handle  > 1 ? handle  : handle  * 100;
  const gapPct = hPct - tPct;

  // Simple rules
  const rules = { maxTicketsPct: 45, minHandlePct: 55, minGap: 10, maxHold: 7, prefHold: 5 };
  if (tPct > rules.maxTicketsPct) return null;
  if (hPct < rules.minHandlePct)  return null;
  if (gapPct < rules.minGap)      return null;
  if (hold != null && hold > rules.maxHold / 100) return null;

  // Score → tier
  let score = 0;
  if (gapPct >= rules.minGap) score += 2;
  if (hold == null || hold <= rules.prefHold / 100) score += 1;

  const tier = score >= 3 ? "strong" : score >= 2 ? "lean" : "pass";
  if (tier === "pass") return null;

  // Build alert
  const side = s.side || (hPct >= tPct ? "home" : "away");
  const team = side === "home" ? meta.home : meta.away;
  const line = s.line ?? null;

  return finalizeAlert({
    ...meta,
    source: "splits",
    score,
    tier,
    side,
    team,
    entryLine: line,
    priceBook: null,
    evPct: null,
    signals: [
      { key: "split_gap", label: `Handle > Tickets by ${Math.round(gapPct)}%`, weight: 2 },
      ...(hold != null ? [{ key: "hold", label: `Hold ${Math.round(hold * 100)}%`, weight: 1 }] : []),
    ],
  });
}

/* ================================ EV PATH =================================
   Key improvement: when evaluating a book’s price, we build consensus FAIR
   from *other* books (exclude the candidate) to avoid diluting edges.       */
function analyzeWithEV(offers, meta) {
  // Partition target vs non-target books.
  const all = offers;
  const targetSet   = ALERT_ALL ? all : all.filter(o => ALERT_BOOKS.includes(o.book));
  const nonTargetSet = ALERT_ALL ? all : all.filter(o => !ALERT_BOOKS.includes(o.book));

  // If ALERT_ALL, we’ll still exclude each candidate from consensus below.
  if (targetSet.length === 0) {
    diag(() => console.log(`diag[EV] ${meta.away} @ ${meta.home} | no target offers (ALERT_BOOKS=[${ALERT_BOOKS.join(",")}])`));
    return null;
  }

  let best = null;

  for (const o of targetSet) {
    // Build consensus excluding this candidate book (preferred).
    let consensusPool = all.filter(x => x.book !== o.book);
    if (!consensusPool.length) {
      // Fallback to non-target pool (if we’re not ALERT_ALL).
      consensusPool = nonTargetSet.length ? nonTargetSet : all;
    }

    const fair = buildFairFrom(consensusPool);
    if (!fair) continue;

    // Evaluate both sides at this book.
    if (isFiniteNum(o.home)) {
      const evH = evFromFair(o.home, fair.pHome);
      if (!best || evH > best.evPct) best = { side: "home", price: o.home, book: o.book, evPct: evH, fairN: fair.n, fairPH: fair.pHome };
    }
    if (isFiniteNum(o.away)) {
      const evA = evFromFair(o.away, 1 - fair.pHome);
      if (!best || evA > best.evPct) best = { side: "away", price: o.away, book: o.book, evPct: evA, fairN: fair.n, fairPH: fair.pHome };
    }
  }

  if (!best) return null;

  const ev = best.evPct;
  const tier = ev >= STRONG_THRESHOLD ? "strong" : ev >= LEAN_THRESHOLD ? "lean" : "pass";
  if (tier === "pass") {
    diag(() => console.log(`diag[EV] ${meta.away} @ ${meta.home} | best EV ${(ev * 100).toFixed(2)}% below gates`));
    return null;
  }

  const team = best.side === "home" ? meta.home : meta.away;

  return finalizeAlert({
    ...meta,
    source: "ev",
    score: Math.round(ev * 10000) / 100, // EV% with 2 dp
    tier,
    side: best.side,
    team,
    entryLine: best.price,
    priceBook: best.book,
    evPct: ev,
    signals: [
      { key: "consensus_n", label: `Consensus N=${best.fairN}`,     weight: 1 },
      { key: "fair_home",   label: `Fair(Home) ${(best.fairPH*100).toFixed(1)}%`, weight: 1 },
      { key: "ev_pct",      label: `+${(ev*100).toFixed(2)}% EV`,   weight: 2 },
      { key: "book",        label: `Book ${best.book}`,             weight: 1 },
    ],
  });
}

/* ============================= FAIR/EV HELPERS ============================ */
function buildFairFrom(consensusOffers) {
  const rows = [];
  for (const o of consensusOffers) {
    if (!isFiniteNum(o.home) || !isFiniteNum(o.away)) continue;
    const pH_raw = impliedFromAmerican(o.home);
    const pA_raw = impliedFromAmerican(o.away);
    const s = pH_raw + pA_raw;
    if (s <= 0) continue;
    const pH = pH_raw / s; // devig within book
    rows.push(pH);
  }
  if (!rows.length) return null;
  return { pHome: avg(rows), n: rows.length };
}

function evFromFair(american, fairP) {
  const dec = americanToDecimal(american);
  // EV per $1 stake: fairP*(dec-1) - (1 - fairP)
  return fairP * (dec - 1) - (1 - fairP);
}

/* ================================ UTILITIES ================================ */
function normalizeOffers(snap) {
  const out = [];
  const seen = new Set();
  for (const o of snap?.offers || []) {
    const book = String(o.book || o.bookmaker || "").toLowerCase().trim();
    if (!book || seen.has(book)) continue;
    const home = num(o?.prices?.home?.american, null);
    const away = num(o?.prices?.away?.american, null);
    if (!isFiniteNum(home) || !isFiniteNum(away)) continue;
    seen.add(book);
    out.push({ book, home, away });
  }
  return out;
}
function hasSplits(s) {
  return typeof s?.tickets === "number" && typeof s?.handle === "number";
}

function americanToDecimal(a) {
  const n = Number(a);
  if (!Number.isFinite(n)) return NaN;
  return n > 0 ? 1 + n / 100 : 1 + 100 / Math.abs(n);
}
function impliedFromAmerican(a) {
  const n = Number(a);
  if (!Number.isFinite(n)) return NaN;
  return n > 0 ? 100 / (n + 100) : Math.abs(n) / (Math.abs(n) + 100);
}

/* --------------------------- Alert Construction --------------------------- */
function finalizeAlert({
  sport, market, gameId, home, away, commence_time,
  source, score, tier, side, team, entryLine, priceBook, evPct, signals,
}) {
  // Dedupe / cooldown (30m). Only re-alert if price improved.
  const key = gameId || `${home}-${away}-${market}`;
  const now = Date.now();
  const prev = STATE[key];
  let allow = true;
  let type = "initial";

  if (prev) {
    const cooldownMs = 30 * 60 * 1000;
    if (now - prev.ts < cooldownMs) {
      if (isFiniteNum(entryLine) && isFiniteNum(prev.entryLine)) {
        if (americanBetter(entryLine, prev.entryLine)) {
          type = "realert_plus";
        } else {
          allow = false;
        }
      } else {
        allow = false;
      }
    }
  }
  if (!allow) return null;

  STATE[key] = { ts: now, entryLine: entryLine ?? null, side };
  saveState();

  const strengthEmoji = tier === "strong" ? "🟢 Strong" : "🟡 Lean";

  return {
    type,
    source,
    sport,
    market,
    game_id: key,
    game: { away, home, start_time_utc: commence_time },
    sharp_side: { side, team, confidence: tier },
    lines: {
      sharp_entry: entryLine ?? null,
      current_consensus: entryLine ?? null,
      direction: "flat",
      book: priceBook || null,
    },
    score: score ?? null,
    signals: signals || [],
    render: {
      title: `SHARP ALERT – ${String(sport || "").toUpperCase()} ${away} @ ${home}`,
      emoji: type === "initial" ? "🚨" : type === "realert_plus" ? "🟢" : "🔁",
      strength: strengthEmoji,
      tags: [source === "ev" ? "EV" : "Splits"],
    },
    meta: { generated_at: new Date().toISOString() },
  };
}

/* --------------------------------- Helpers -------------------------------- */
function americanBetter(curr, prev) {
  if (!isFiniteNum(curr) || !isFiniteNum(prev)) return false;
  // Dogs: higher is better; Favs: closer to zero (less negative) is better.
  return curr > prev;
}
function avg(arr) { let s = 0; for (const x of arr) s += x; return arr.length ? s / arr.length : NaN; }
function isFiniteNum(x) { return Number.isFinite(Number(x)); }
function num(x, def = undefined) { const n = Number(x); return Number.isFinite(n) ? n : def; }
function envNum(k, def) { const n = Number(process.env[k]); return Number.isFinite(n) ? n : def; }
function envBool(k, def) {
  const v = process.env[k]; if (v == null) return def;
  const s = String(v).toLowerCase();
  if (["1","true","yes","y"].includes(s)) return true;
  if (["0","false","no","n"].includes(s)) return false;
  return def;
}
function diag(fn) { if (DIAG) { try { fn(); } catch {} } }
