import fs from "fs";
import config from "./config.js";

const stateFile = config.profiles[config.activeProfile].stateFile || "./sharp_state.json";
let state = {};

// Load state on startup
if (fs.existsSync(stateFile)) {
  try {
    state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  } catch {
    state = {};
  }
}

// Persist state to disk
function saveState() {
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
}

/**
 * Analyze market snapshot and decide if sharp alert should fire
 */
export function analyzeMarket(snapshot) {
  const profile = config.profiles[config.activeProfile];
  const now = Date.now();

  if (!snapshot || typeof snapshot !== "object") return null;

  const { tickets, handle, market, gameId, home, away, best } = snapshot;

  // -------------------- Handle vs Tickets --------------------
  if (typeof tickets !== "number" || typeof handle !== "number") return null;

  const gap = handle - tickets;
  if (tickets > profile.handleTickets.maxTicketsPct) return null;
  if (handle < profile.handleTickets.minHandlePct) return null;
  if (gap < profile.handleTickets.minGap) return null;

  // -------------------- Hold Filter --------------------
  if (snapshot.hold && snapshot.hold > profile.hold.skipAbove) return null;

  // -------------------- Score (very simple demo for now) --------------------
  let score = 0;
  if (gap >= profile.handleTickets.minGap) score += 2;
  if (snapshot.hold && snapshot.hold <= profile.hold.max) score += 1;

  const strength =
    score >= config.thresholds.strong
      ? "strong"
      : score >= config.thresholds.lean
      ? "lean"
      : "pass";

  if (strength === "pass") return null;

  // -------------------- State + Re-Alerts --------------------
  const key = gameId || `${home}-${away}-${market}`;
  const prev = state[key];

  let type = "initial";
  if (prev) {
    const expired = now - prev.ts > profile.reAlerts.expiryHours * 3600 * 1000;
    if (!expired) {
      if (snapshot.line && prev.entryLine) {
        if (snapshot.line === prev.entryLine) {
          type = "realert";
        } else if (
          (snapshot.side === "home" && snapshot.line > prev.entryLine) ||
          (snapshot.side === "away" && snapshot.line < prev.entryLine)
        ) {
          type = "realert_plus";
        }
      }
    }
  }

  // -------------------- Save state --------------------
  state[key] = {
    ts: now,
    entryLine: snapshot.line,
    side: snapshot.side
  };
  saveState();

  // -------------------- Build alert payload --------------------
  return {
    type,
    sport: snapshot.sport,
    market,
    game_id: key,
    game: {
      away,
      home,
      start_time_utc: snapshot.commence_time || null
    },
    sharp_side: {
      side: snapshot.side,
      team: snapshot.side === "home" ? home : away,
      confidence: strength
    },
    lines: {
      sharp_entry: snapshot.line,
      current_consensus: snapshot.line,
      direction: "flat"
    },
    score,
    render: {
      title: `SHARP ALERT – ${snapshot.sport.toUpperCase()} ${away} @ ${home}`,
      emoji: type === "initial" ? "🚨" : type === "realert_plus" ? "🟢" : "🔁",
      strength: strength === "strong" ? "🟢 Strong" : "🟡 Lean",
      tags: ["H/T Gap"]
    },
    meta: {
      profile: config.activeProfile,
      generated_at: new Date().toISOString()
    }
  };
}
