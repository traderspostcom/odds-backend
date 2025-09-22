export default {
  /* -------------------- Profiles -------------------- */
  profiles: {
      /* -------------------- Score thresholds (global) -------------------- */
  thresholds: {
    strong: 5,   // 🟢 STRONG at score ≥ 5
    lean: 3      // 🟡 LEAN at score ≥ 3
  },
    // 🟢 Sharpest of the sharp
    sharpest: {
      handleTickets: {
        maxTicketsPct: 40,   // Tickets ≤ 40%
        minHandlePct: 55,    // Handle ≥ 55%
        minGap: 15           // Handle - Tickets ≥ 15%
      },
      hold: {
        max: 0.025,          // ≤ 2.5% hold only
        skipAbove: 0.05      // Skip if hold > 5%
      },
      signals: {
        minSharpBooks: 2,    // Need ≥2 sharp books
        sharpBooks: ["pinnacle", "circa", "cris"]
      },
      keyNumbers: {
        enforce: true,
        nfl: [3, 7, 10],
        nba: [3, 7],
        mlbTotals: [7, 8.5, 9]
      },
      reAlerts: {
        enabled: true,
        minScore: 5,        // Only re-alert if Strong
        cooldownMinutes: 45,
        expiryHours: 12
      }
    },

    // 🟡 Pro (a little looser, but still sharp)
    pro: {
      handleTickets: {
        maxTicketsPct: 45,   // Tickets ≤ 45%
        minHandlePct: 55,    // Handle ≥ 55%
        minGap: 10           // Handle - Tickets ≥ 10%
      },
      hold: {
        max: 0.035,          // ≤ 3.5% hold
        skipAbove: 0.06
      },
      signals: {
        minSharpBooks: 1,    // Need ≥1 sharp book
        sharpBooks: ["pinnacle", "circa", "cris"]
      },
      keyNumbers: {
        enforce: true,
        nfl: [3, 7, 10],
        nba: [3, 7],
        mlbTotals: [7, 8.5, 9]
      },
      reAlerts: {
        enabled: true,
        minScore: 4,        // Re-alert if Lean+
        cooldownMinutes: 30,
        expiryHours: 18
      }
    },

    // 🟠 Balanced (looser, more signals)
    balanced: {
      handleTickets: {
        maxTicketsPct: 50,   // Tickets ≤ 50%
        minHandlePct: 52,    // Handle ≥ 52%
        minGap: 8            // Handle - Tickets ≥ 8%
      },
      hold: {
        max: 0.05,           // ≤ 5% hold
        skipAbove: 0.07
      },
      signals: {
        minSharpBooks: 1,    // Allow single sharp book
        sharpBooks: ["pinnacle", "circa", "cris"]
      },
      keyNumbers: {
        enforce: false,      // Don’t strictly filter by key numbers
        nfl: [3, 7, 10],
        nba: [3, 7],
        mlbTotals: [7, 8.5, 9]
      },
      reAlerts: {
        enabled: true,
        minScore: 3,        // Re-alert if Lean+
        cooldownMinutes: 20,
        expiryHours: 24
      }
    }
  },

  /* -------------------- Default Profile -------------------- */
  activeProfile: process.env.SHARP_PROFILE || "sharpest"
};
