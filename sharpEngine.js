// sharpEngine.js (root)
// Hybrid analyzer: Splits → EV → Outlier, with optional dedupe bypass.
// EV path already upgraded. This version upgrades OUTLIER with fair/EV/Kelly/Play-to,
// plus quality gates: consensus size, z-filter outliers, staleness, steam/resistance, scarcity.

import fs from "fs";

/* ============================== ENV / KNOBS =============================== */
const DIAG = envBool("DIAG", true);

// Legacy EV gates (kept for compatibility; dynamic verdicts override when used)
const LEAN_THRESHOLD   = envNum("LEAN_THRESHOLD", 0.010);  // 1.0%
const STRONG_THRESHOLD = envNum("STRONG_THRESHOLD", 0.020); // 2.0%

// Outlier diff gates (vs median, in “cents”)
const OUT_DOG_LEAN   = envInt("OUTLIER_DOG_CENTS_LEAN", 10);
const OUT_DOG_STRONG = envInt("OUTLIER_DOG_CENTS_STRONG", 18);
const OUT_FAV_LEAN   = envInt("OUTLIER_FAV_CENTS_LEAN", 7);
const OUT_FAV_STRONG = envInt("OUTLIER_FAV_CENTS_STRONG", 12);

// Books to alert on — ENV is the single source of truth.
// ALERT_BOOKS supports "*" or a CSV list like "pinnacle,betmgm".
const RAW_ALERT_BOOKS = (process.env.ALERT_BOOKS || "")
  .split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
const ALERT_ALL   = RAW_ALERT_BOOKS.includes("*");
const ALERT_BOOKS = RAW_ALERT_BOOKS.filter(b => b !== "*");

// Quality gates (tunable via env; sensible defaults)
const CONS_MIN_STRICT = envInt("CONSENSUS_MIN_BOOKS_STRICT", 5); // full power
const CONS_MIN_LOOSE  = envInt("CONSENSUS_MIN_BOOKS_LOOSE", 3);  // degrade tier if 3–4
const Z_MAX           = envNum("OUTLIER_SD_Z_MAX", 1.5);         // drop > 1.5 SD from mean
const STALE_SECS      = envInt("STALE_SECS", 120);               // candidate older than peers by this
const DISP_CENTS_STALE= envInt("DISPERSION_CENTS_FOR_STALE", 5); // need dispersion ≥ this to stale-flag
const STEAM_WIN_SEC   = envInt("STEAM_WINDOW_SEC", 180);
const STEAM_CENTS     = envInt("STEAM_CENTS", 5);
const RESIST_WIN_SEC  = envInt("RESIST_WINDOW_SEC", 600);
const RESIST_REVERSALS= envInt("RESIST_REVERSALS", 2);
const SCARCITY_AT_MOST= envInt("SCARCITY_AT_MOST", 2);
const EV_FLOOR_PCT    = envNum("EV_FLOOR_PERCENT", 0.25);        // don’t send < 0.25% EV

// Simple re-alert state (cooldown 30m) + small history for steam/resistance
const STATE_FILE = process.env.SHARP_STATE_FILE || "./sharp_state.json";
let STATE = {};
try { if (fs.existsSync(STATE_FILE)) STATE = JSON.parse(fs.readFileSync(STATE_FILE, "utf8") || "{}"); }
catch { STATE = {}; }
if (typeof STATE !== "object" || STATE === null) STATE = {};
if (!STATE._hist) STATE._hist = {}; // { keySide: [ { ts, med }, ... ] up to ~50 }
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

  // 1) Splits (when available)
  if (hasSplits(snapshot)) {
    const a = analyzeWithSplits(snapshot, { sport, market, gameId, home, away, commence_time }, { bypassDedupe });
    if (a) return a;
  }

  // 2) Price-based signals
  const offers = normalizeOffers(snapshot); // {book, home, away, last_update}
  if (offers.length < 2) {
    diag(() => console.log(`diag[ANZ] ${away} @ ${home} | offers=${offers.length} (need ≥2)`));
    return null;
  }

  const all = offers;

  // If ALERT_BOOKS was left empty and not "*", fail closed (log once per game)
  if (!ALERT_ALL && ALERT_BOOKS.length === 0) {
    diag(() => console.log(`diag[ANZ] ALERT_BOOKS empty; set ALERT_BOOKS in env`));
    return null;
  }

  const target    = ALERT_ALL ? all : all.filter(o => ALERT_BOOKS.includes(o.book));
  const nonTarget = ALERT_ALL ? all : all.filter(o => !ALERT_BOOKS.includes(o.book));
  if (!target.length) {
    diag(() => console.log(`diag[ANZ] ${away} @ ${home} | no target offers in [${ALERT_BOOKS.join(",") || "EMPTY"}]`));
    return null;
  }

  // EV (already upgraded)
  const evA = analyzeWithEV(all, target, nonTarget, { sport, market, gameId, home, away, commence_time }, { bypassDedupe });
  if (evA) { recordMediansForHistory({ gameId, offers: all, home, away }); return evA; }

  // OUTLIER (upgraded here)
  const out = analyzeWithOutliersUpgraded(all, target, nonTarget, { sport, market, gameId, home, away, commence_time }, { bypassDedupe });
  recordMediansForHistory({ gameId, offers: all, home, away });
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
function analyzeWithEV(all, target, nonTarget, meta, { bypassDedupe }) {
  let best = null;

  for (const o of target) {
    let consensusPool = all.filter(x => x.book !== o.book);
    if (!consensusPool.length) consensusPool = nonTarget.length ? nonTarget : all;

    const fair = buildFairFrom(consensusPool);
    if (!fair) continue;

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

  const pModel = best.side === "home" ? best.fairPH : (1 - best.fairPH);
  const evFrac = best.evPct;
  const edgePct = (pModel - impliedProbAmerican(best.price)) * 100;
  const minutes = minutesToPost(meta.commence_time);
  const kellyRawPct = kellyFrac(best.price, pModel) * 100;
  const cap = sportCapPct(meta.sport);
  const kellyHalfPct = Math.min(cap, kellyRawPct / 2);
  const verdict = decideVerdict({ sport: meta.sport, minutes, edgePct, evPct: evFrac * 100, kellyPct: kellyRawPct });

  if (verdict === "pass" || evFrac * 100 < EV_FLOOR_PCT) {
    diag(() => console.log(`diag[EV] ${meta.away} @ ${meta.home} | pass edge=${edgePct.toFixed(2)} ev=${(evFrac*100).toFixed(2)} kelly=${kellyRawPct.toFixed(2)}`));
    return null;
  }

  const team = best.side === "home" ? meta.home : meta.away;
  const playTo = playToFromProb(pModel);
  const tier = verdict === "strong" ? "strong" : "lean";

  return finalizeAlert({
    ...meta,
    source: "ev",
    score: Math.round(evFrac * 10000) / 100,
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

/* ============================ OUTLIER (UPGRADED) ========================== */
// (unchanged logic – omitted for brevity in this comment block)
function analyzeWithOutliersUpgraded(all, target, nonTarget, meta, { bypassDedupe }) {
  const results = [];

  for (const o of target) {
    const othersRaw = all.filter(x => x.book !== o.book);
    if (othersRaw.length < CONS_MIN_LOOSE) continue;

    // z-filter: drop books > Z_MAX SD off mean (per side)
    const clean = (side) => {
      const vals = othersRaw.map(x => x[side]).filter(isFiniteNum);
      if (vals.length < CONS_MIN_LOOSE) return { pool: [], stats: null, dropped: 0 };
      const mean = avg(vals), sdv = sd(vals);
      if (!Number.isFinite(sdv) || sdv === 0) return { pool: [...othersRaw], stats: { mean, sd: 0 }, dropped: 0 };
      const pool = othersRaw.filter(x => {
        const z = Math.abs(((x[side]) - mean) / sdv);
        return !Number.isFinite(z) || z <= Z_MAX;
      });
      const dropped = othersRaw.length - pool.length;
      return { pool, stats: { mean, sd: sdv }, dropped };
    };

    for (const side of ["home","away"]) {
      const price = o[side];
      if (!isFiniteNum(price)) continue;

      const { pool, stats, dropped } = clean(side);
      if (pool.length < CONS_MIN_LOOSE) continue;

      const medSide = median(pool.map(x => x[side]).filter(isFiniteNum));
      if (!isFiniteNum(medSide)) continue;
      const diff = price - medSide;
      const isDog = price >= 0;
      const leanGate   = isDog ? OUT_DOG_LEAN : OUT_FAV_LEAN;
      const strongGate = isDog ? OUT_DOG_STRONG : OUT_FAV_STRONG;
      if (diff < leanGate) continue;

      const fair = buildFairFrom(pool);
      if (!fair) continue;

      const pModel = side === "home" ? fair.pHome : (1 - fair.pHome);
      const evFrac = evFromFair(price, pModel);
      const edgePct = (pModel - impliedProbAmerican(price)) * 100;
      const minutes = minutesToPost(meta.commence_time);

      let verdict = decideVerdict({ sport: meta.sport, minutes, edgePct, evPct: evFrac * 100, kellyPct: kellyFrac(price, pModel)*100 });

      const consN = fair.n;
      let consNote = null;
      if (consN < CONS_MIN_STRICT && consN >= CONS_MIN_LOOSE) {
        if (verdict === "strong") verdict = "medium";
        consNote = "low_consensus";
      }
      if (consN < CONS_MIN_LOOSE) continue;

      const peerAges = pool.map(x => secsSinceISO(x.last_update)).filter(isFiniteNum);
      const candAge  = secsSinceISO(o.last_update);
      const disp = stats ? Math.abs(stats.sd || 0) : 0;
      let stale = false;
      if (isFiniteNum(candAge) && peerAges.length) {
        const medAge = median(peerAges);
        if ((candAge - medAge) > STALE_SECS && centsAbs(disp) >= DISP_CENTS_STALE) {
          stale = true;
          if (verdict === "strong") verdict = "medium";
          else if (verdict === "medium") verdict = "pass";
        }
      }

      const keySide = `${meta.gameId || meta.home + "-" + meta.away}-${side}`;
      const medSeries = getHistoryWindow(keySide, Math.max(STEAM_WIN_SEC, RESIST_WIN_SEC));
      const nowMedAll = median(all.map(x => x[side]).filter(isFiniteNum));
      if (Number.isFinite(nowMedAll)) pushHistoryPoint(keySide, nowMedAll);

      let steamUp = false, resist = false;
      if (medSeries.length >= 2) {
        const pastSteam = medSeries.filter(p => (Date.now() - p.ts) <= STEAM_WIN_SEC*1000);
        if (pastSteam.length >= 2) {
          const oldest = pastSteam[0].med, newest = pastSteam[pastSteam.length-1].med;
          const delta = newest - oldest;
          if (delta <= -STEAM_CENTS) steamUp = true;
        }
        const pastRes = medSeries.filter(p => (Date.now() - p.ts) <= RESIST_WIN_SEC*1000);
        if (pastRes.length >= 3) {
          let rev = 0;
          for (let i=2;i<pastRes.length;i++){
            const a = pastRes[i-2].med, b=pastRes[i-1].med, c=pastRes[i].med;
            const d1 = Math.sign(b-a), d2 = Math.sign(c-b);
            if (d1 && d2 && d1 !== d2) rev++;
          }
          if (rev >= RESIST_REVERSALS) resist = true;
        }
      }

      if (steamUp && (verdict === "medium")) {
        const T = verdictThresholds(meta.sport, minutes);
        const kPct = kellyFrac(price, pModel)*100;
        const strongish = (edgePct >= (T.edgeS - 0.3)) && ((evFrac*100) >= (T.evS - 0.2));
        if (strongish) verdict = "strong";
      }
      if (resist && (verdict === "strong")) verdict = "medium";

      const playTo = playToFromProb(pModel);
      let scarce = false;
      if (playTo) {
        const playableCnt = all.filter(x => isPlayable(x[side], playTo.rounded)).length;
        if (playableCnt <= SCARCITY_AT_MOST) {
          scarce = true;
          const evPct = evFrac*100;
          if (verdict !== "strong" && edgePct >= 2.2 && evPct >= 0.8 && evPct <= 0.95) verdict = "strong";
        }
      }

      if (verdict === "pass" || (evFrac*100) < EV_FLOOR_PCT) continue;

      const tier = verdict === "strong" ? "strong" : "lean";
      const team = side === "home" ? meta.home : meta.away;
      const cap = sportCapPct(meta.sport);
      const kRaw = kellyFrac(price, pModel)*100;
      const kHalf = Math.min(cap, kRaw/2);

      const signals = [
        { key:"consensus_n", label:`Consensus N=${(fair?.n)||0}`, weight:1 },
        ...(dropped ? [{ key:"z_drop", label:`Dropped ${dropped} book(s) > ${Z_MAX}σ`, weight:1 }] : []),
        { key:"median_ref",  label:`Median ${side.toUpperCase()} ${fmtAm(medSide)}`, weight:1 },
        { key:"delta_cents", label:`+${Math.round(diff)}¢ vs market`, weight:2 },
        { key:"edge_pct",    label:`Edge ${edgePct.toFixed(2)}%`, weight:2 },
        { key:"ev_pct",      label:`+${(evFrac*100).toFixed(2)}% EV`, weight:2 },
        { key:"kelly",       label:`Kelly ${kRaw.toFixed(1)}% / ½ ${kHalf.toFixed(1)}% (cap ${cap.toFixed(1)}%)`, weight:1 },
        ...(playTo ? [{ key:"play_to", label:`Play-to ${playTo.exact} / ${playTo.rounded}`, weight:1 }] : []),
        { key:"book",        label:`Book ${o.book}`, weight:1 },
        { key:"verdict",     label:`Verdict ${verdict.toUpperCase()}`, weight:2 },
        { key:"t2p",         label:`T-${minutesToPost(meta.commence_time)}m`, weight:1 },
        ...(consNote ? [{ key:"consensus_note", label:"Low consensus (tier trimmed)", weight:1 }] : []),
        ...(stale ? [{ key:"stale", label:`Stale by >${STALE_SECS}s`, weight:1 }] : []),
        ...(steamUp ? [{ key:"steam", label:"Steam↑", weight:1 }] : []),
        ...(resist ? [{ key:"resist", label:"Resistance↔", weight:1 }] : []),
        ...(scarce ? [{ key:"scarce", label:"Scarce price", weight:1 }] : []),
      ];

      results.push({
        meta, side, team, tier, verdict, price, book:o.book, evFrac, diff, medSide,
        signals, pModel, playTo, consN: fair.n
      });
    }
  }

  if (!results.length) return null;

  results.sort((a,b)=>{
    const rank = v => v.verdict==="strong"?2 : v.verdict==="medium"?1:0;
    if (rank(b)!==rank(a)) return rank(b)-rank(a);
    if (Math.round(b.diff)!==Math.round(a.diff)) return Math.round(b.diff)-Math.round(a.diff);
    return (b.evFrac - a.evFrac);
  });
  const best = results[0];
  const { side, team, tier, price, book, evFrac, signals } = best;

  return finalizeAlert({
    ...best.meta,
    source: "outlier",
    score: Math.round(best.diff),
    tier, side, team,
    entryLine: price, priceBook: book, evPct: evFrac,
    signals,
    bypassDedupe: false,
  });
}

/* ====================== HISTORY (steam / resistance) ====================== */
function recordMediansForHistory({ gameId, offers, home, away }) {
  const keyH = `${gameId}-home`;
  const keyA = `${gameId}-away`;
  const medH = median(offers.map(o => o.home).filter(isFiniteNum));
  const medA = median(offers.map(o => o.away).filter(isFiniteNum));
  if (Number.isFinite(medH)) pushHistoryPoint(keyH, medH);
  if (Number.isFinite(medA)) pushHistoryPoint(keyA, medA);
}
function pushHistoryPoint(key, med) {
  const arr = STATE._hist[key] || [];
  arr.push({ ts: Date.now(), med });
  while (arr.length > 60) arr.shift();
  STATE._hist[key] = arr;
  saveState();
}
function getHistoryWindow(key, seconds) {
  const cut = Date.now() - seconds*1000;
  return (STATE._hist[key] || []).filter(p => p.ts >= cut);
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
  return fairP * (dec - 1) - (1 - fairP);
}

/* ================================= UTIL =================================== */
function normalizeOffers(snap) {
  const out = [];
  const perBook = new Map();
  const homeName = snap.home || snap?.game?.home;
  const awayName = snap.away || snap?.game?.away;

  for (const o of snap?.offers || []) {
    const book = String(o.book || o.bookmaker || o.key || "").toLowerCase().trim();
    if (!book) continue;

    if (o.team && (o.american != null)) {
      const row = perBook.get(book) || { book, home: undefined, away: undefined, last_update: o.last_update || null };
      if (o.team === homeName) row.home = num(o.american, row.home);
      else if (o.team === awayName) row.away = num(o.american, row.away);
      row.last_update = newerISO(row.last_update, o.last_update);
      perBook.set(book, row);
      continue;
    }
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
function secsSinceISO(s) { const t = Date.parse(s); return Number.isFinite(t) ? Math.round((Date.now()-t)/1000) : NaN; }

function hasSplits(s) { return typeof s?.tickets === "number" && typeof s?.handle === "number"; }

function americanToDecimal(a) { const n = Number(a); if (!Number.isFinite(n)) return NaN; return n > 0 ? 1 + n/100 : 1 + 100/Math.abs(n); }
function decimalToAmerican(d) { return d >= 2 ? Math.round((d - 1) * 100) : Math.round(-100 / (d - 1)); }
function impliedFromAmerican(a) { const n = Number(a); if (!Number.isFinite(n)) return NaN; return n > 0 ? 100/(n+100) : Math.abs(n)/(Math.abs(n)+100); }
function impliedProbAmerican(a) { return impliedFromAmerican(a); }

function isPlayable(american, playToRounded) { return Number.isFinite(american) && Number.isFinite(playToRounded) && (american >= playToRounded); }

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
  return "MLB_NHL";
}
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
  if (minutes >= 360) { edgeS -= 0.3; evS -= 0.2; edgeMmin = Math.max(0, edgeMmin - 0.3); evMmin = Math.max(0, evMmin - 0.2); }
  else if (minutes <= 60) { edgeS += 0.3; evS += 0.2; edgeMmin += 0.3; evMmin += 0.2; }
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
  if (am < 0) { const q = Math.trunc(Math.abs(am) / step); return -(q * step); }
  else { const q = Math.trunc(am / step); return q * step; }
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
  if (band === "MLB_NHL") return 1.0;
  return 2.0;
}

/* --------------------------------- Helpers -------------------------------- */
function americanBetter(curr, prev) { if (!isFiniteNum(curr) || !isFiniteNum(prev)) return false; return curr > prev; }
function fmtAm(a) { return a >= 0 ? `+${a}` : `${a}`; }
function rankTier(t) { return t === "strong" ? 2 : 1; }
function avg(a){let s=0;for(const x of a)s+=x;return a.length?s/a.length:NaN;}
function sd(a){const m=avg(a);const v=avg(a.map(x=>(x-m)*(x-m)));return Math.sqrt(v);}
function median(a){const b=[...a].sort((x,y)=>x-y);const n=b.length;if(!n)return NaN;const m=Math.floor(n/2);return n%2?b[m]:(b[m-1]+b[m])/2;}
function centsAbs(x){return Math.abs(Number(x)||0);}
function isFiniteNum(x){return Number.isFinite(Number(x));}
function num(x,def=undefined){const n=Number(x);return Number.isFinite(n)?n:def;}
function envNum(k,def){const n=Number(process.env[k]);return Number.isFinite(n)?n:def;}
function envInt(k,def){const n=parseInt(process.env[k],10);return Number.isFinite(n)?n:def;}
function envBool(k,def){const v=process.env[k];if(v==null)return def;const s=String(v).toLowerCase();if(["1","true","yes","y"].includes(s))return true;if(["0","false","no","n"].includes(s))return false;return def;}
function diag(fn){ if (DIAG) { try { fn(); } catch {} } }
