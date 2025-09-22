// sharpEngine.js
import fs from "fs";
import config from "./config.js";

/* -------------------- Load active profile & thresholds -------------------- */
const profileKey = config.activeProfile || "sharpest";
const profile = config.profiles?.[profileKey] || config.profiles?.sharpest;
const thresholds = config.thresholds || { strong: 5, lean: 3 };

/* -------------------- State (per-profile file) -------------------- */
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

/* -------------------- Helpers -------------------- */
function hasSplits(s) {
  return typeof s?.tickets === "number" && typeof s?.handle === "number";
}
function americanBetter(current, entry) {
  // Returns true if 'current' is a better (more favorable) price than 'entry' for the same side (moneyline).
  // For positives (dogs): higher is better, e.g., +130 > +120
  // For negatives (favs): closer to zero (less negative) is better, e.g., -110 > -120
  if (current == null || entry == null) return false;
  if (entry >= 0) return current > entry;       // dog: want higher number
  return current > entry;                        // fav: -110 > -120 (numerically greater) is better
}
function americanEqual(a, b) {
  return Number(a) === Number(b);
}
function withinHoldLimit(h) {
  if (typeof h !== "number") return true; // if unknown, don't fail on hold
  const lim = typeof profile?.hold?.max === "number" ? profile.hold.max : 0.05;
  const hardSkip = typeof profile?.hold?.skipAbove === "number" ? profile.hold.skipAbove : 0.07;
  if (h > hardSkip) return false;
  return h <= lim;
}

/* -------------------- Main analyzer -------------------- */
export function analyzeMarket(snapshot) {
  // Defensive input checks
  if (!snapshot || typeof snapshot !== "object") return null;

  // Require basic fields
  const {
    sport, market, gameId, home, away,
    commence_time, tickets, handle, hold, line, side
  } = snapshot;

  // If your plan lacks splits: bail early (prevents analyzed=0 confusion)
  if (!hasSplits(snapshot)) return null;

  // Tickets/Handle gates (profile-driven)
  const gap = handle - tickets; // both expressed as 0..100? or 0..1? We assume 0..100 if upstream normalizes so.
  // Normalize if the feed uses 0..1
  const tPct = tickets > 1 ? tickets : tickets * 100;
  const hPct = handle  > 1 ? handle  : handle  * 100;
  const gapPct = hPct - tPct;

  const ht = profile?.handleTickets || { maxTicketsPct: 45, minHandlePct: 55, minGap: 10 };
  if (tPct > ht.maxTicketsPct) return null;
  if (hPct < ht.minHandlePct) return null;
  if (gapPct < ht.minGap) return null;

  // Hold screen
  if (!withinHoldLimit(hold)) return null;

  // (Simple) scoring — keep light; you can expand later with RLM/steam/outlier signals
  let score = 0;
  if (gapPct >= ht.minGap) score += 2;
  if (typeof hold === "number" && hold <= (profile?.hold?.max ?? 0.05)) score += 1;

  // Tiering
  const tier =
    score >= thresholds.strong ? "strong" :
    score >= thresholds.lean   ? "lean"   :
    "pass";
  if (tier === "pass") return null;

  // Build key for (re)alerts
  const key = gameId || `${home}-${away}-${market}`;
  const now = Date.now();
  const prev = state[key];

  // Re-alert policy
  const reCfg = profile?.reAlerts || { enabled: true, minScore: thresholds.lean, cooldownMinutes: 30, expiryHours: 18 };
  let alertType = "initial";
  let allowSend = true;

  if (prev) {
    const expired = now - prev.ts > (reCfg.expiryHours ?? 18) * 3600 * 1000;
    if (!expired) {
      const improved = americanBetter(line, prev.entryLine);
      const equal = americanEqual(line, prev.entryLine);
      const withinCooldown = now - prev.ts < (reCfg.cooldownMinutes ?? 30) * 60 * 1000;

      if (improved) {
        alertType = "realert_plus"; // improvement can bypass cooldown if you want
        // still require min score for re-alerts
        if ((reCfg.enabled === false) || (score < (reCfg.minScore ?? thresholds.lean))) allowSend = false;
      } else if (equal) {
        alertType = "realert";
        // Avoid spam: enforce cooldown & minScore
        if (withinCooldown) allowSend = false;
        if ((reCfg.enabled === false) || (score < (reCfg.minScore ?? thresholds.lean))) allowSend = false;
      } else {
        // price got worse — usually do not alert again
        allowSend = false;
      }
    }
  }

  if (!allowSend) return null;

  // Update state (persist after deciding to send)
  state[key] = {
    ts: now,
    entryLine: line,
    side
  };
  saveState();

  // Construct alert payload (normalized)
  const startET = commence_time || null;
  const sideTeam = side === "home" ? home : side === "away" ? away : "Split";
  const strengthEmoji = tier === "strong" ? "🟢 Strong" : "🟡 Lean";

  return {
    type: alertType,                 // "initial" | "realert" | "realert_plus"
    sport,
    market,
    game_id: key,
    game: {
      away, home,
      start_time_utc: startET
    },
    sharp_side: {
      side,
      team: sideTeam,
      confidence: tier
    },
    lines: {
      sharp_entry: line,
      current_consensus: line,
      direction: "flat"
    },
    score,
    signals: [
      { key: "split_gap", label: `Handle>Tickets by ${gapPct.toFixed(0)}%`, weight: 2 }
    ],
    render: {
      title: `SHARP ALERT – ${String(sport || "").toUpperCase()} ${away} @ ${home}`,
      emoji: alertType === "initial" ? "🚨" : alertType === "realert_plus" ? "🟢" : "🔁",
      strength: strengthEmoji,
      tags: ["H/T Gap"]
    },
    meta: {
      profile: profileKey,
      generated_at: new Date().toISOString()
    }
  };
}
