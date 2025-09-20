// ================== Probability & Odds Conversions ==================

// Convert American odds → implied probability (0–1)
export function ipFromAmerican(a) {
  const n = Number(a);
  if (!Number.isFinite(n) || n === 0) return null;
  return n > 0 ? 100 / (n + 100) : (-n) / ((-n) + 100);
}

// Convert implied probability (0–1) → American odds
export function amFromIp(prob) {
  if (prob <= 0 || prob >= 1) return null;
  return prob > 0.5
    ? -(prob / (1 - prob)) * 100
    : ((1 - prob) / prob) * 100;
}

// ================== Expected Value (EV) ==================

// Expected value per 1 unit risk, given American odds and your model win prob
export function evAmerican(american, pModel) {
  const risk = 1;
  const win = american > 0 ? american / 100 : 100 / (-american);
  return pModel * win - (1 - pModel) * risk;
}

// ================== Best Line & Market Metrics ==================

// From one game blob, find best price per team and compute hold + de-vigged probs
export function bestLinesAndMetrics(game) {
  const best = new Map();

  for (const bm of game.bookmakers ?? []) {
    for (const m of bm.markets ?? []) {
      if (m.key !== "h2h") continue;
      for (const o of m.outcomes ?? []) {
        const team = o.name;   // team name
        const price = o.price; // American odds (int)
        const ip = ipFromAmerican(price);

        // Lower implied probability = better price for bettor
        const cur = best.get(team);
        if (!cur || ip < cur.ip) best.set(team, { book: bm.title, price, ip });
      }
    }
  }

  const sides = Object.fromEntries(best);
  const teams = Object.keys(sides);
  if (teams.length !== 2) return null;

  const [A, B] = teams;
  const ipA = sides[A].ip;
  const ipB = sides[B].ip;
  const hold = ipA + ipB - 1;

  // Proportional de-vig
  const pA = ipA / (ipA + ipB);
  const pB = 1 - pA;

  return {
    teams: { A, B },
    best: sides,           // { "Team": { book, price, ip }, ... }
    hold,                  // e.g. 0.032 = 3.2%
    devig: { [A]: pA, [B]: pB }
  };
}
