// src/fetchers.js
import * as odds from "../odds_service.js";

/**
 * Env toggle helper — supports 1/true/yes/on (case-insensitive)
 */
export const isOn = (key, def = false) => {
  const v = String(process.env[key] ?? "").trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  return !!def;
};

/**
 * FETCHERS:
 * Every market is a function returning a normalized array of snapshots.
 * NFL 1H fetchers are optional; if not present in odds_service.js they’ll be undefined.
 */
export const FETCHERS = {
  nfl: {
    h2h:     odds.getNFLH2HNormalized,
    spreads: odds.getNFLSpreadsNormalized,
    totals:  odds.getNFLTotalsNormalized,

    // Optional First Half markets (only used if defined)
    h1_h2h:     odds.getNFLH1H2HNormalized,
    h1_spreads: odds.getNFLH1SpreadsNormalized,
    h1_totals:  odds.getNFLH1TotalsNormalized
  },

  mlb: {
    h2h:         odds.getMLBH2HNormalized,
    spreads:     odds.getMLBSpreadsNormalized,
    totals:      odds.getMLBTotalsNormalized,
    f5_h2h:      odds.getMLBF5H2HNormalized,
    f5_totals:   odds.getMLBF5TotalsNormalized,
    team_totals: odds.getMLBTeamTotalsNormalized, // Some regions/endpoints may 422 — your fetch wrapper will skip
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
