// config.js
export default {
  /* -------------------- Scoring Weights -------------------- */
  scoring: {
    // Reverse Line Move: handle side ≠ tickets side
    RLM: 2.0,

    // Steam: multiple sharp books move in same direction
    STEAM: 2.0,

    // Crossing key numbers (NFL spread ex: 3, 7)
    KEYNUM: 1.5,

    // Late sharp move close to kickoff/tipoff
    LATE: 1.5,

    // Outlier vs consensus (one sharp book shaded differently)
    OUTLIER: 1.0,

    // Handle/Ticket split reversal
    SPLIT: 1.0,

    // Consensus indicators (public fade, etc.)
    CONSENSUS: 1.0
  },

  /* -------------------- Thresholds -------------------- */
  thresholds: {
    strong: 5.0,  // "Strong" alert if score ≥ 5
    lean: 3.0     // "Lean" alert if score ≥ 3
    // <3 = PASS (no alert)
  },

  /* -------------------- Re-Alert Rules -------------------- */
  reAlert: {
    cooldownMinutes: 20, // Minimum wait before same game can trigger again
    expiryMinutes: 240   // Stop tracking game 4h after start
  },

  /* -------------------- State Storage -------------------- */
  stateFile: "./sharp_state.json" // Persist alerts here
};
