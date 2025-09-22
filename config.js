// config.js
// Central config shared by the sharp engine & routes.
// - thresholds moved to top-level
// - per-profile defaults intact
// - optional stateFile per profile (you can customize paths)

const thresholds = {
  strong: 5, // 🟢 STRONG at score ≥ 5
  lean: 3    // 🟡 LEAN at score ≥ 3
};

const baseSignals = {
  minSharpBooks: 1,
  sharpBooks: ["pinnacle", "circa", "cris"]
};

const profiles = {
  // 🟢 Sharpest
  sharpest: {
    handleTickets: { maxTicketsPct: 40, minHandlePct: 55, minGap: 15 },
    hold: { max: 0.025, skipAbove: 0.05 },
    signals: { ...baseSignals, minSharpBooks: 2 },
    keyNumbers: { enforce: true, nfl: [3,7,10], nba: [3,7], mlbTotals: [7,8.5,9] },
    reAlerts: { enabled: true, minScore: 5, cooldownMinutes: 45, expiryHours: 12 },
    stateFile: "./sharp_state_sharpest.json"
  },

  // 🟡 Pro
  pro: {
    handleTickets: { maxTicketsPct: 45, minHandlePct: 55, minGap: 10 },
    hold: { max: 0.035, skipAbove: 0.06 },
    signals: { ...baseSignals, minSharpBooks: 1 },
    keyNumbers: { enforce: true, nfl: [3,7,10], nba: [3,7], mlbTotals: [7,8.5,9] },
    reAlerts: { enabled: true, minScore: 4, cooldownMinutes: 30, expiryHours: 18 },
    stateFile: "./sharp_state_pro.json"
  },

  // 🟠 Balanced
  balanced: {
    handleTickets: { maxTicketsPct: 50, minHandlePct: 52, minGap: 8 },
    hold: { max: 0.05, skipAbove: 0.07 },
    signals: { ...baseSignals, minSharpBooks: 1 },
    keyNumbers: { enforce: false, nfl: [3,7,10], nba: [3,7], mlbTotals: [7,8.5,9] },
    reAlerts: { enabled: true, minScore: 3, cooldownMinutes: 20, expiryHours: 24 },
    stateFile: "./sharp_state_balanced.json"
  }
};

const activeProfile = process.env.SHARP_PROFILE || "sharpest";

export default {
  thresholds,
  profiles,
  activeProfile
};
