export default {
  /* -------------------- Sharp Scoring Weights -------------------- */
  scoring: {
    RLM: 2.0,
    STEAM: 2.0,
    KEYNUM: 1.5,
    LATE: 1.5,
    OUTLIER: 1.0,
    SPLIT: 1.0,
    CONSENSUS: 1.0
  },

  /* -------------------- Sharp Thresholds -------------------- */
  thresholds: {
    strong: 5.0,
    lean: 3.0
  },

  /* -------------------- Sharp Re-Alert Rules -------------------- */
  reAlert: {
    cooldownMinutes: 20,
    expiryMinutes: 240
  },

  /* -------------------- Sharp State Storage -------------------- */
  stateFile: "./sharp_state.json",

  /* -------------------- Scan Windows -------------------- */
  scan: {
    startHourET: Number(process.env.SCAN_START_HOUR || 6),
    stopHourET: Number(process.env.SCAN_STOP_HOUR || 24),
    intervalMinutes: Number(process.env.SCAN_INTERVAL || 3)
  },

  /* -------------------- Sports + Market Toggles -------------------- */
  sports: {
    mlb: {
      f5: process.env.SCAN_MLB_F5 === "true",
      full: process.env.SCAN_MLB_FULL === "true"
    },
    nfl: {
      h1: process.env.SCAN_NFL_H1 === "true",
      full: process.env.SCAN_NFL_FULL === "true"
    },
    ncaaf: {
      h1: process.env.SCAN_NCAAF_H1 === "true",
      full: process.env.SCAN_NCAAF_FULL === "true"
    },
    nba: {
      h1: process.env.SCAN_NBA_H1 === "true",
      full: process.env.SCAN_NBA_FULL === "true"
    },
    ncaab: {
      h1: process.env.SCAN_NCAAB_H1 === "true",
      full: process.env.SCAN_NCAAB_FULL === "true"
    }
  }
};
