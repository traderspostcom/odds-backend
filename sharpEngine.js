// sharpEngine.js
import fs from "fs";
import config from "./config.js";

/* -------------------------------------------------------------------------- */
/*  Active profile, thresholds, and env                                       */
/* -------------------------------------------------------------------------- */
const profileKey = config.activeProfile || "sharpest";
const profile = config.profiles?.[profileKey] || config.profiles?.sharpest || {};

const SCORE_THRESHOLDS = config.thresholds || { strong: 5, lean: 3 }; // used for SPLITS path
const EV_THRESHOLDS = {
  // market-only EV thresholds (percent, e.g., 0.015 = 1.5%)
  strong:
    numFromEnv("STRONG_THRESHOLD") ??
    config.evThresholds?.strong ??
    0.03,
  lean:
    numFromEnv("LEAN_THRESHOLD") ??
    config.evThresholds?.lean ??
    0.015,
};

const TARGET_ALERT_BOOKS = (process.env.ALERT_BOOKS || "pinnacle")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

const DIAG = boolFromEnv("DIAG", false);

/* -------------------------------------------------------------------------- */
/*  State (per-profile file)                                                  */
/* -------------------------------------------------------------------------- */
const stateFile = profile?.stateFile || "./sharp_state.json";
let state = {};
try {
  if (fs.existsSync(stateFile)) {
    state = JSON.parse(fs.readFileSync(stateFile, "utf8") || "{}");
  }
} catch {
  state = {};
}
function saveState() {
  try {
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
  } catch (e) {
    console.warn("⚠️ Could not persist sharp state:", e?.message || e);
  }
}

/* -------------------------------------------------------------------------- */
/*  Public API                                                                */
/* -------------------------------------------------------------------------- */
export function analyzeMarket(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return null;

  // Common fields we try to use when present
  const {
    sport,
    market,
    gameId,
    home,
    away,
    commence_time,
    hold: snapshotHold,
    tickets,
    handle,
    side,          // may be provided by upstream on split path
    line: price,   // may be provided by upstream on split path (american)
  } = snapshot;

  // 1) If splits are present, use SPLITS path
  if (hasSplits({ tickets, handle })) {
    const result = evaluateWithSplits({
      snapshot,
      sport,
      market,
      gameId,
      home,
      away,
      commence_time,
      hold: snapshotHold,
      tickets,
      handle,
      side,
      price,
    });
    if (result) return result;
    // If splits path doesn't qualify, we still try EV path as a fallback.
  }

  // 2) Otherwise use MARKET-ONLY EV path (consensus devig)
  const offers = normalizeOffers(snapshot);
  if (offers.length < 2) {
    // Need at least 2 books to form a non-circular consensus
    diag(() =>
      console.log(
        `diag[${market}] insufficient offers for consensus: ${offers.length}`
      )
    );
    return null;
  }

  return evaluateWithEV({
    snapshot,
    sport,
    market,
    gameId,
    home,
    away,
    commence_time,
    offers,
  });
}

/* -------------------------------------------------------------------------- */
/*  SPLITS path                                                               */
/* -------------------------------------------------------------------------- */
function evaluateWithSplits({
  snapshot,
  sport,
  market,
  gameId,
  home,
  away,
  commence_time,
  hold,
  tickets,
  handle,
  side,
  price,
}) {
  const ht = profile?.handleTickets || {
    maxTicketsPct: 45,
    minHandlePct: 55,
    minGap: 10,
  };

  // Normalize potential 0..1 to 0..100
  const tPct = tickets > 1 ? tickets : tickets * 100;
  const hPct = handle > 1 ? handle : handle * 100;
  const gapPct = hPct - tPct;

  // Hold screen (if provided)
  if (!withinHoldLimit(hold)) return null;

  // Gates
  if (tPct > ht.maxTicketsPct) return null;
  if (hPct < ht.minHandlePct) return null;
  if (gapPct < ht.minGap) return null;

  // Score-based tiering (simple)
  let score = 0;
  if (gapPct >= ht.minGap) score += 2;
  if (typeof hold === "number" && hold <= (profile?.hold?.max ?? 0.05)) score += 1;

  const tier =
    score >= SCORE_THRESHOLDS.strong
      ? "strong"
      : score >= SCORE_THRESHOLDS.lean
      ? "lean"
      : "pass";
  if (tier === "pass") return null;

  // Build key (split path is single-side)
  const key = makeStateKey({
    gameId,
    home,
    away,
    market,
    book: "splits",
    side: side || "split",
  });
  const now = Date.now();
  const prev = state[key];

  const reCfg =
    profile?.reAlerts || {
      enabled: true,
      minScore: SCORE_THRESHOLDS.lean,
      cooldownMinutes: 30,
      expiryHours: 18,
    };

  let alertType = "initial";
  let allowSend = true;
  let direction = "flat";

  if (prev) {
    const expired = now - prev.ts > (reCfg.expiryHours ?? 18) * 3600 * 1000;
    if (!expired) {
      const improved = americanBetter(price, prev.entryLine);
      const equal = americanEqual(price, prev.entryLine);
      const withinCooldown =
        now - prev.ts < (reCfg.cooldownMinutes ?? 30) * 60 * 1000;

      if (improved) {
        direction = "improved";
        alertType = "realert_plus";
        if (
          reCfg.enabled === false ||
          score < (reCfg.minScore ?? SCORE_THRESHOLDS.lean)
        )
          allowSend = false;
      } else if (equal) {
        direction = "flat";
        alertType = "realert";
        if (withinCooldown) allowSend = false;
        if (
          reCfg.enabled === false ||
          score < (reCfg.minScore ?? SCORE_THRESHOLDS.lean)
        )
          allowSend = false;
      } else {
        direction = "worse";
        allowSend = false;
      }
    }
  }

  if (!allowSend) return null;

  state[key] = {
    ts: now,
    entryLine: price ?? null,
    evPct: null,
    side: side || "split",
    source: "splits",
  };
  saveState();

  const strengthEmoji = tier === "strong" ? "🟢 Strong" : "🟡 Lean";
  const sideTeam =
    side === "home" ? home : side === "away" ? away : "Split Side";

  return {
    type: alertType,
    source: "splits",
    sport,
    market,
    game_id: key,
    game: {
      away,
      home,
      start_time_utc: commence_time || null,
    },
    sharp_side: {
      side: side || "split",
      team: sideTeam,
      confidence: tier,
    },
    lines: {
      sharp_entry: price ?? null,
      current_consensus: null,
      direction,
    },
    score,
    signals: [
      { key: "split_gap", label: `Handle>Tickets by ${gapPct.toFixed(0)}%`, weight: 2 },
    ],
    render: {
      title: `SHARP ALERT – ${String(sport || "").toUpperCase()} ${away} @ ${home}`,
      emoji:
        alertType === "initial" ? "🚨" : alertType === "realert_plus" ? "🟢" : "🔁",
      strength: strengthEmoji,
      tags: ["H/T Gap"],
    },
    meta: {
      profile: profileKey,
      generated_at: new Date().toISOString(),
    },
  };
}

/* -------------------------------------------------------------------------- */
/*  EV path (consensus devig; excludes evaluated book from consensus)         */
/* -------------------------------------------------------------------------- */
function evaluateWithEV({
  snapshot,
  sport,
  market,
  gameId,
  home,
  away,
  commence_time,
  offers,
}) {
  // Evaluate only target alert books, but build consensus from ALL other books
  const targetOffers = offers.filter((o) =>
    TARGET_ALERT_BOOKS.includes((o.book || o.bookmaker || "").toLowerCase())
  );

  if (targetOffers.length === 0) {
    diag(() => console.log(`diag[${market}] no target alert books in offers`));
    return null;
  }

  let best = null;

  for (const offer of targetOffers) {
    const bookKey = (offer.book || offer.bookmaker || "").toLowerCase();
    const consensusPool = offers.filter(
      (o) => (o.book || o.bookmaker || "").toLowerCase() !== bookKey
    );

    if (consensusPool.length === 0) {
      // avoid circular EV
      continue;
    }

    // compute devigged fair from consensus
    const fair = makeFairFromConsensus(consensusPool);

    // skip if we couldn't make a reasonable fair
    if (!(fair.home > 0 && fair.away > 0)) continue;

    // If hold screen is desired, use the offer's own hold
    const derivedHold = holdFromOffer(offer);
    if (!withinHoldLimit(derivedHold)) continue;

    // compute EV for both sides at the target book
    const homeAmerican = readAmerican(offer, "home");
    const awayAmerican = readAmerican(offer, "away");
    if (homeAmerican == null || awayAmerican == null) continue;

    const homeDec = americanToDecimal(homeAmerican);
    const awayDec = americanToDecimal(awayAmerican);
    const evHome = (homeDec * fair.home - 1) * 100; // percent
    const evAway = (awayDec * fair.away - 1) * 100;

    // choose the better side at this book
    const sideChoice = evHome >= evAway ? "home" : "away";
    const evPct = sideChoice === "home" ? evHome : evAway;
    const entryAmerican = sideChoice === "home" ? homeAmerican : awayAmerican;

    // tiering by EV thresholds
    const tier =
      evPct >= EV_THRESHOLDS.strong
        ? "strong"
        : evPct >= EV_THRESHOLDS.lean
        ? "lean"
        : "pass";
    if (tier === "pass") continue;

    const candidate = {
      bookKey,
      sideChoice,
      evPct,
      entryAmerican,
      fair,
      offer,
    };

    if (!best || candidate.evPct > best.evPct) best = candidate;
  }

  if (!best) return null;

  // Re-alert logic (keyed by game+market+book+side)
  const key = makeStateKey({
    gameId,
    home,
    away,
    market,
    book: best.bookKey,
    side: best.sideChoice,
  });

  const now = Date.now();
  const prev = state[key];
  const reCfg =
    profile?.reAlerts || {
      enabled: true,
      minEvPct: EV_THRESHOLDS.lean * 100, // legacy safeguard if % points; we use percent already
      cooldownMinutes: 30,
      expiryHours: 18,
    };

  let alertType = "initial";
  let allowSend = true;
  let direction = "flat";

  if (prev) {
    const expired = now - prev.ts > (reCfg.expiryHours ?? 18) * 3600 * 1000;
    if (!expired) {
      const priceImproved = americanBetter(best.entryAmerican, prev.entryLine);
      const evImproved = prev.evPct == null ? true : best.evPct > prev.evPct + 0.25; // +0.25pp buffer
      const withinCooldown =
        now - prev.ts < (reCfg.cooldownMinutes ?? 30) * 60 * 1000;

      if (priceImproved || evImproved) {
        direction = "improved";
        alertType = "realert_plus";
        if (reCfg.enabled === false) allowSend = false;
      } else if (americanEqual(best.entryAmerican, prev.entryLine)) {
        direction = "flat";
        alertType = "realert";
        if (withinCooldown) allowSend = false;
        if (reCfg.enabled === false) allowSend = false;
      } else {
        direction = "worse";
        allowSend = false;
      }
    }
  }

  if (!allowSend) return null;

  // Persist state
  state[key] = {
    ts: now,
    entryLine: best.entryAmerican,
    evPct: best.evPct,
    side: best.sideChoice,
    source: "ev",
  };
  saveState();

  const tier =
    best.evPct >= EV_THRESHOLDS.strong
      ? "strong"
      : best.evPct >= EV_THRESHOLDS.lean
      ? "lean"
      : "pass";
  const strengthEmoji = tier === "strong" ? "🟢 Strong" : "🟡 Lean";
  const teamChosen = best.sideChoice === "home" ? home : away;

  // Build diagnostic signal list
  const signals = [
    {
      key: "ev_pct",
      label: `EV ${best.evPct.toFixed(2)}%`,
      weight: best.evPct >= 3 ? 3 : 2,
    },
    {
      key: "consensus_n",
      label: `Consensus N=${countConsensusBooksExcluding(offers, best.bookKey)}`,
      weight: 1,
    },
  ];

  return {
    type: alertType,
    source: "ev",
    sport,
    market,
    game_id: key,
    game: {
      away,
      home,
      start_time_utc: commence_time || null,
    },
    sharp_side: {
      side: best.sideChoice,
      team: teamChosen,
      confidence: tier,
    },
    lines: {
      sharp_entry: best.entryAmerican, // american price at target book on chosen side
      fair_prob: best.fair,            // { home, away } probabilities from consensus
      direction,
    },
    score: evScoreFromTier(tier, best.evPct),
    signals,
    render: {
      title: `SHARP ALERT – ${String(sport || "").toUpperCase()} ${away} @ ${home}`,
      emoji:
        alertType === "initial" ? "🚨" : alertType === "realert_plus" ? "🟢" : "🔁",
      strength: strengthEmoji,
      tags: ["EV", "Consensus"],
    },
    meta: {
      profile: profileKey,
      generated_at: new Date().toISOString(),
      book: best.bookKey,
    },
  };
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */
function hasSplits(s) {
  return typeof s?.tickets === "number" && typeof s?.handle === "number";
}

function withinHoldLimit(h) {
  if (typeof h !== "number") return true; // if unknown, don't fail on hold
  const lim =
    typeof profile?.hold?.max === "number" ? profile.hold.max : 0.05;
  const hardSkip =
    typeof profile?.hold?.skipAbove === "number" ? profile.hold.skipAbove : 0.07;
  if (h > hardSkip) return false;
  return h <= lim;
}

function americanBetter(current, entry) {
  // "Better" = more favorable to bettor (bigger plus, or less negative)
  if (current == null || entry == null) return false;
  return Number(current) > Number(entry);
}
function americanEqual(a, b) {
  if (a == null || b == null) return false;
  return Number(a) === Number(b);
}

function makeStateKey({ gameId, home, away, market, book, side }) {
  const base = gameId || `${home}-${away}`;
  return `${base}|${market}|${book}|${side}`;
}

function numFromEnv(k) {
  const v = process.env[k];
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function boolFromEnv(k, def = false) {
  const v = process.env[k];
  if (v == null) return def;
  const s = String(v).toLowerCase();
  if (["1", "true", "yes", "y"].includes(s)) return true;
  if (["0", "false", "no", "n"].includes(s)) return false;
  return def;
}
function diag(fn) {
  if (DIAG) try { fn(); } catch {}
}

/* ----------------------------- Odds utilities ----------------------------- */
function americanToDecimal(a) {
  a = Number(a);
  return a > 0 ? 1 + a / 100 : 1 - 100 / a; // note: a is negative for favs
}
function impliedFromAmerican(a) {
  a = Number(a);
  return a > 0 ? 100 / (a + 100) : -a / (-a + 100);
}
function devigTwoWay(pAraw, pBraw) {
  const sum = pAraw + pBraw;
  if (sum <= 0) return { pA: 0.5, pB: 0.5 };
  return { pA: pAraw / sum, pB: pBraw / sum };
}

function holdFromOffer(offer) {
  const h = readAmerican(offer, "home");
  const a = readAmerican(offer, "away");
  if (h == null || a == null) return undefined;
  const pH = impliedFromAmerican(h);
  const pA = impliedFromAmerican(a);
  return pH + pA - 1; // overround
}

function median(arr) {
  if (!arr?.length) return 0.5;
  const s = [...arr].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
}

function makeFairFromConsensus(offers) {
  const favProbs = [];
  const dogProbs = [];
  for (const o of offers) {
    const h = readAmerican(o, "home");
    const a = readAmerican(o, "away");
    if (h == null || a == null) continue;
    const pHomeRaw = impliedFromAmerican(h);
    const pAwayRaw = impliedFromAmerican(a);
    const { pA: pHome, pB: pAway } = devigTwoWay(pHomeRaw, pAwayRaw);
    favProbs.push(pHome);
    dogProbs.push(pAway);
  }
  const pHomeFair = median(favProbs);
  const pAwayFair = median(dogProbs);
  // Normalize in case of oddities
  const sum = pHomeFair + pAwayFair;
  if (sum > 0) {
    return { home: pHomeFair / sum, away: pAwayFair / sum };
  }
  return { home: 0.5, away: 0.5 };
}

function normalizeOffers(snapshot) {
  // Expected flexible shapes:
  // 1) snapshot.offers = [{ book|bookmaker, prices: { home: { american }, away: { american } } }, ...]
  // 2) snapshot.offers = [{ key, outcomes: [{ name: 'home', price: { american }}, { name: 'away', price: { american }}]}]
  const raw = Array.isArray(snapshot?.offers) ? snapshot.offers : [];
  const out = [];

  for (const o of raw) {
    const book = o.book || o.bookmaker || o.key || "";
    // Case 1
    if (o?.prices?.home?.american != null && o?.prices?.away?.american != null) {
      out.push({
        book,
        prices: {
          home: { american: Number(o.prices.home.american) },
          away: { american: Number(o.prices.away.american) },
        },
      });
      continue;
    }
    // Case 2: outcomes array
    if (Array.isArray(o?.outcomes)) {
      const homeNode = o.outcomes.find(
        (x) =>
          (x.name || x.side || x.label)?.toLowerCase?.() === "home"
      );
      const awayNode = o.outcomes.find(
        (x) =>
          (x.name || x.side || x.label)?.toLowerCase?.() === "away"
      );
      if (homeNode?.price?.american != null && awayNode?.price?.american != null) {
        out.push({
          book,
          prices: {
            home: { american: Number(homeNode.price.american) },
            away: { american: Number(awayNode.price.american) },
          },
        });
      }
    }
  }

  // De-dupe by (book)
  const seen = new Set();
  return out.filter((o) => {
    const k = (o.book || "").toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function readAmerican(offer, side) {
  try {
    return Number(offer?.prices?.[side]?.american);
  } catch {
    return undefined;
  }
}

function countConsensusBooksExcluding(allOffers, excludeBookKey) {
  const set = new Set(
    allOffers
      .map((o) => (o.book || o.bookmaker || "").toLowerCase())
      .filter((b) => b && b !== excludeBookKey)
  );
  return set.size;
}

function evScoreFromTier(tier, evPct) {
  if (tier === "strong") return Math.max(5, Math.round(3 + evPct / 1.5));
  if (tier === "lean") return Math.max(3, Math.round(1 + evPct / 2.0));
  return 0;
}
