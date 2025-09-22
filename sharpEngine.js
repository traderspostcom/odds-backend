// sharpEngine.js
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
 * Analyze one market snapshot → return structured sharp alert payload or null
 */
export function analyzeMarket(snapshot) {
  const {
    gameId,
    sport,
    league,
    market,
    away,
    home,
    commence_time,
    tickets,
    handle,
    consensusLine,
    prevConsensusLine,
    bookLines
  } = snapshot;

  const signals = [];
  let score = 0;

  /* -------------------- Reverse Line Move -------------------- */
  if (typeof tickets === "object" && typeof handle === "object") {
    const homeDiff = (handle.home ?? 0) - (tickets.home ?? 0);
    const awayDiff = (handle.away ?? 0) - (tickets.away ?? 0);
    if (Math.max(homeDiff, awayDiff) >= 10) {
      const side = homeDiff > awayDiff ? "home" : "away";
      signals.push({
        code: "RLM",
        label: "Reverse Line Move",
        data: {
          handle_side: side,
          tickets_pct_home: tickets.home,
          tickets_pct_away: tickets.away,
          handle_pct_home: handle.home,
          handle_pct_away: handle.away
        },
        points: config.scoring.RLM
      });
      score += config.scoring.RLM;
    }
  }

  /* -------------------- STEAM (stub) -------------------- */
  if (bookLines && bookLines.moves) {
    if (bookLines.moves.home >= 2) {
      signals.push({
        code: "STEAM",
        label: "Steam",
        data: { home_moves: bookLines.moves.home, away_moves: bookLines.moves.away },
        points: config.scoring.STEAM
      });
      score += config.scoring.STEAM;
    }
  }

  /* -------------------- Key Number Cross (stub) -------------------- */
  if (prevConsensusLine && consensusLine) {
    if (prevConsensusLine === 3 && consensusLine === 2.5) {
      signals.push({
        code: "KEYNUM",
        label: "Key Number Cross",
        data: { prev_consensus: prevConsensusLine, current_consensus: consensusLine },
        points: config.scoring.KEYNUM
      });
      score += config.scoring.KEYNUM;
    }
  }

  /* -------------------- Outlier vs Consensus (stub) -------------------- */
  if (bookLines && bookLines.outlier) {
    signals.push({
      code: "OUTLIER",
      label: "Outlier vs Consensus",
      data: { books: [bookLines.outlier] },
      points: config.scoring.OUTLIER
    });
    score += config.scoring.OUTLIER;
  }

  /* -------------------- Confidence -------------------- */
  let confidence = "pass";
  if (score >= config.thresholds.strong) confidence = "strong";
  else if (score >= config.thresholds.lean) confidence = "lean";

  let sharpSide = null;
  if (signals.length > 0) {
    const first = signals[0];
    sharpSide = first.data.handle_side || "home";
  }

  const entryLine = prevConsensusLine || consensusLine;
  const currentLine = consensusLine;
  let recommendation = { status: "WATCH", reason: "No clear entry logic yet" };

  if (confidence === "strong" && currentLine === entryLine) {
    recommendation = { status: "BET_NOW", reason: "Sharp entry matched" };
  } else if (confidence === "strong" && currentLine !== entryLine) {
    recommendation = { status: "PASS", reason: "Missed key number" };
  }

  /* -------------------- Build Alert -------------------- */
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
    books_considered: ["pinnacle", "circa", "cris"],
    signals,
    score,
    sharp_side: {
      side: sharpSide,
      team: sharpSide === "home" ? home : away,
      confidence
    },
    lines: {
      sharp_entry: entryLine,
      current_consensus: currentLine,
      direction: "flat"
    },
    recommendation,
    notes: [],
    render: {
      title: `SHARP ALERT – ${league} ${away} @ ${home}`,
      emoji: "🚨",
      strength: confidence === "strong" ? "🟢 Strong" : "🟡 Lean",
      tags: signals.map((s) => s.code)
    },
    meta: { version: "1.0.0", generated_at: new Date().toISOString() }
  };

  /* -------------------- Re-Alert State Tracking -------------------- */
  if (!state[gameId]) {
    state[gameId] = { entry: entryLine, lastAlert: Date.now() };
    saveState();
    return payload;
  }

  const prev = state[gameId];
  const minutesSince = (Date.now() - prev.lastAlert) / 60000;
  if (minutesSince < config.reAlert.cooldownMinutes) {
    return null; // cooldown
  }

  if (currentLine === prev.entry) {
    payload.type = "realert";
    payload.recommendation = { status: "BET_NOW", reason: "Sharp entry matched again" };
    state[gameId].lastAlert = Date.now();
    saveState();
    return payload;
  }

  if (
    (sharpSide === "home" && currentLine > prev.entry) ||
    (sharpSide === "away" && currentLine < prev.entry)
  ) {
    payload.type = "realert_plus";
    payload.recommendation = { status: "BET_NOW", reason: "Better than sharp entry" };
    state[gameId].lastAlert = Date.now();
    saveState();
    return payload;
  }

  return null;
}
