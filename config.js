export default {
  /* -------------------- Sharp Scoring Weights -------------------- */
  scoring: {
    RLM: 2.0,        // Reverse Line Move
    STEAM: 2.0,      // Steam
    KEYNUM: 1.5,     // Key Number Cross
    LATE: 1.5,       // Late Sharp Move
    OUTLIER: 1.0,    // Outlier vs Consensus
    SPLIT: 1.0,      // Handle/Ticket Split Reversal
    CONSENSUS: 1.0   // Public consensus fade
  },

  /* -------------------- Sharp Thresholds -------------------- */
  thresholds: {
    strong: 5.0,  // ≥ 5 = Strong Alert
    lean: 3.0     // 3–4 = Lean Alert
    // <3 = PASS
  },

  /* -------------------- Sharp Re-Alert Rules -------------------- */
  reAlert: {
    cooldownMinutes: 20,  // Wait before same game can re-trigger
    expiryMinutes: 240    // Expire 4h after game start
  },

  /* -------------------- Sharp State Storage -------------------- */
  stateFile: "./sharp_state.json", // Persist sharp alerts here

  /* -------------------- Scan Windows -------------------- */
  scan: {
    startHourET: Number(process.env.SCAN_START_HOUR || 6),   // default 6 AM ET
    stopHourET: Number(process.env.SCAN_STOP_HOUR || 24),    // default midnight ET
    intervalMinutes: Number(process.env.SCAN_INTERVAL || 3)  // default every 3 minutes
  },

  /* -------------------- Sports + Market Toggles -------------------- */
  sports: {
    mlb:   { f5: true, full: true },
    nfl:   { h1: true, full: true },
    ncaaf: { h1: true, full: true },
    nba:   { h1: process.env.SCAN_NBA_H1 === "true", full: true },
    ncaab: { h1: process.env.SCAN_NCAAB_H1 === "true", full: true }
  }
};
