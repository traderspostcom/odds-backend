// src/fetchers.js
// Centralized map of all sport/market fetchers + a tiny env-toggle helper.

import * as odds from "../odds_service.js";

/**
 * Env toggle helper.
 * Accepts: 1, true, yes, on (case-insensitive) → true
 *          0, false, no, off → false
 * Otherwise returns the provided default.
 */
export const isOn = (key, def = false) => {
  const v = String(process.env[key] ?? "").trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  return !!def;
};

/**
 * FETCHERS
 * Every market function should return an array of normalized snapshots.
 * NFL 1H fetchers below are optional; if not exported by odds_service.js,
 * they remain undefined and your calling code should gate/skip them.
 */
export const FETCHERS = {
  nfl: {
    // Full game
    h2h:     odds.getNFLH2HNormalized,
    spreads: odds.getNFLSpreadsNormalized,
    totals:  odds.getNFLTotalsNormalized,

    // First Half (optional; only used if defined upstream)
    h1_h2h:     odds.getNFLH1H2HNormalized,
    h1_spreads: odds.getNFLH1SpreadsNormalized,
    h1_totals:  odds.getNFLH1TotalsNormalized
  },

  mlb: {
    h2h:         odds.getMLBH2HNormalized,
    spreads:     odds.getMLBSpreadsNormalized,
    totals:      odds.getMLBTotalsNormalized,

    // First 5
    f5_h2h:      odds.getMLBF5H2HNormalized,
    f5_totals:   odds.getMLBF5TotalsNormalized,

    // Extras (availability may vary by region/provider; your safe fetch wrapper will skip on 422)
    team_totals: odds.getMLBTeamTotalsNormalized,
    alt:         odds.getMLBAltLinesNormalized
  },

  nba: {
    h2h:     odds.getNBAH2HNormalized,
    spreads: odds.getNBASpreadsNormalized,
    totals:  odds.getNBATotalsNormalized
  },

  ncaaf: {
    h2h:     odds.getNCAAFH2HNormalized,
    spreads: odds.getNCAAFSpreadsNormalized,
    totals:  odds.getNCAAFTotalsNormalized
  },

  ncaab: {
    h2h:     odds.getNCAABH2HNormalized,
    spreads: odds.getNCAABSpreadsNormalized,
    totals:  odds.getNCAABTotalsNormalized
  },

  tennis: {
    h2h: odds.getTennisH2HNormalized
  },

  soccer: {
    h2h: odds.getSoccerH2HNormalized
  }
};
