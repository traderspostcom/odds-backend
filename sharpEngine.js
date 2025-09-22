import fs from "fs";
import config from "./config.js";

let state = {};
if (fs.existsSync(config.stateFile)) {
  try {
    state = JSON.parse(fs.readFileSync(config.stateFile, "utf-8"));
  } catch {
    state = {};
  }
}

function saveState() {
  fs.writeFileSync(config.stateFile, JSON.stringify(state, null, 2));
}

/**
 * Analyze one market snapshot → return structured alert payload or null.
 */
export function analyzeMarket(snapshot) {
  const { gameId, sport, league, market, away, home, commence_time, tickets, handle, consensusLine, bookLines } = snapshot;

  // 1. Signals
  const signals = [];
  let score = 0;

  // Example: Reverse Line Move (handle vs tickets mismatch + line move)
  if (typeof tickets === "object" && typeof handle === "object") {
    const homeDiff = (handle.home ?? 0) - (tickets.home ?? 0);
    const awayDiff = (handle.away ?? 0) - (tickets.away ?? 0);
    if (Math.max(homeDiff, awayDiff) >= 10) {
      const side = homeDiff > awayDiff ? "home" : "away";
      signals.push({
        code: "RLM",
        label: "Reverse Line Move",
        data: { handle_side: side, tickets_pct_home: tickets.home, tickets_pct_away: tickets.away, handle_pct_home: handle.home, handle_pct_away: handle.away },
        points: config.scoring.RLM
      });
      score += config.scoring.RLM;
    }
  }

  // TODO: Add STEAM, KEYNUM, OUTLIER detection (stubbed for now)
  // This is where you’d calculate based on bookLines + consensus history

  // 2. Sharp Side
  let sharpSide = null;
  let confidence = "pass";
  if (score >= config.thresholds.strong) confidence = "strong";
  else if (score >= config.thresholds.lean) confidence = "lean";

  if (signals.length > 0) {
    const first = signals[0]; // simplification: trust first strong signal
    sharpSide = first.data.handle_side;
  }

  // 3. Lines + Entry Logic
  const entryLine = consensusLine; // initial stub
  const currentLine = consensusLine;
  let recommendation = { status: "WATCH", reason: "No clear entry logic yet" };

  if (confidence === "strong" && currentLine === entryLine) {
    recommendation = { status: "BET_NOW", reason: "Sharp entry matched" };
  }

  // 4. Build payload
  const payload = {
    type: "initial",
    priority: confidence === "strong" ? "high" : "medium",
    sport,
    league,
    market,
    game_id: gameId,
    game: {
      away,
      home,
      start_time_utc: commence_time,
      minutes_to_start: Math.floor((new Date(commence_time) - Date.now()) / 60000)
    },
    books_considered: ["pinnacle", "circa", "cris"], // stub
    signals,
    score,
    sharp_side: { side: sharpSide, team: sharpSide === "home" ? home : away, confidence },
    lines: { sharp_entry: entryLine, current_consensus: currentLine, direction: "flat" },
    recommendation,
    notes: [],
    render: {
      title: `SHARP ALERT – ${league} ${away} @ ${home}`,
      emoji: "🚨",
      strength: confidence === "strong" ? "🟢 Strong" : "🟡 Lean",
      tags: signals.map(s => s.code)
    },
    meta: { version: "1.0.0", generated_at: new Date().toISOString() }
  };

  // 5. Re-alert state tracking
  if (!state[gameId]) {
    state[gameId] = { entry: entryLine, lastAlert: Date.now() };
    saveState();
    return payload;
  }

  const prev = state[gameId];
  const minutesSince = (Date.now() - prev.lastAlert) / 60000;
  if (minutesSince < config.reAlert.cooldownMinutes) {
    return null; // too soon
  }

  if (currentLine === prev.entry) {
    payload.type = "realert";
    payload.recommendation = { status: "BET_NOW", reason: "Sharp entry matched again" };
    state[gameId].lastAlert = Date.now();
    saveState();
    return payload;
  }

  if ((sharpSide === "home" && currentLine > prev.entry) || (sharpSide === "away" && currentLine < prev.entry)) {
    payload.type = "realert_plus";
    payload.recommendation = { status: "BET_NOW", reason: "Better than sharp entry" };
    state[gameId].lastAlert = Date.now();
    saveState();
    return payload;
  }

  return null;
}
