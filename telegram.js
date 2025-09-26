/* src/utils/stake.js — Bankroll staking helper for GoSignals (ESM) */

function toNumber(x) {
  if (x === null || x === undefined) return NaN;
  const n = typeof x === "number" ? x : parseFloat(String(x));
  return Number.isFinite(n) ? n : NaN;
}

export function americanToDecimal(american) {
  const a = toNumber(american);
  if (!Number.isFinite(a)) return NaN;
  if (a >= 100) return 1 + a / 100;
  if (a <= -100) return 1 + 100 / Math.abs(a);
  return NaN;
}

// Kelly fraction k = (d*p - 1) / (d - 1), where d = decimal odds, p = fair prob
export function kellyFromProbAndPrice(p, americanPrice) {
  const pNum = toNumber(p);
  const d = americanToDecimal(americanPrice);
  if (!Number.isFinite(pNum) || !Number.isFinite(d) || d <= 1) return NaN;
  const k = (d * pNum - 1) / (d - 1);
  return k;
}

function roundTo(x, step) {
  const s = toNumber(step);
  if (!Number.isFinite(x) || !Number.isFinite(s) || s <= 0) return NaN;
  // Round half away from zero
  return Math.sign(x) * Math.round(Math.abs(x) / s) * s;
}

export function computeStakeFromAlert(alert) {
  const mode = (process.env.STAKE_MODE || "bankroll").toLowerCase();

  if (mode !== "bankroll") {
    return { stakeUsd: null, stakeUsdRounded: null, kellyFullUsed: null, reason: "STAKE_MODE not bankroll" };
  }

  const BANKROLL_USD   = toNumber(process.env.BANKROLL_USD);
  const KELLY_FRACTION = toNumber(process.env.KELLY_FRACTION);
  const KELLY_MAX_USD  = toNumber(process.env.KELLY_MAX_USD);
  const STAKE_ROUND_TO = toNumber(process.env.STAKE_ROUND_TO || 1);

  if (!Number.isFinite(BANKROLL_USD) || BANKROLL_USD <= 0) {
    return { stakeUsd: 0, stakeUsdRounded: 0, kellyFullUsed: 0, reason: "Invalid BANKROLL_USD" };
  }
  const frac = Number.isFinite(KELLY_FRACTION) ? Math.max(0, Math.min(1, KELLY_FRACTION)) : 0.25;
  const maxCap = Number.isFinite(KELLY_MAX_USD) ? Math.max(0, KELLY_MAX_USD) : Infinity;
  const roundStep = Number.isFinite(STAKE_ROUND_TO) && STAKE_ROUND_TO > 0 ? STAKE_ROUND_TO : 1;

  // 1) Preferred: explicit kellyFull provided by analysis
  let kellyFull = toNumber(alert?.metrics?.kellyFull);
  if (!Number.isFinite(kellyFull)) {
    // 2) Next: metrics.kelly if it looks like a fraction [0..1]
    const kMaybe = toNumber(alert?.metrics?.kelly);
    if (Number.isFinite(kMaybe) && kMaybe >= 0 && kMaybe <= 1) {
      kellyFull = kMaybe;
    }
  }

  // 3) Fallback: derive from fair prob + offered price
  if (!Number.isFinite(kellyFull)) {
    const p = toNumber(alert?.metrics?.fair_prob);
    const american = alert?.pick?.price ?? alert?.price;
    const k = kellyFromProbAndPrice(p, american);
    if (Number.isFinite(k)) kellyFull = k;
  }

  if (!Number.isFinite(kellyFull) || kellyFull <= 0) {
    return { stakeUsd: 0, stakeUsdRounded: 0, kellyFullUsed: 0, reason: "No positive Kelly" };
  }

  // Fractional Kelly
  let stake = BANKROLL_USD * kellyFull * frac;

  // Clamp to max and non-negative
  if (stake < 0) stake = 0;
  if (Number.isFinite(maxCap)) stake = Math.min(stake, maxCap);

  const stakeRounded = roundTo(stake, roundStep);
  return {
    stakeUsd: stake,
    stakeUsdRounded: Math.max(0, stakeRounded || 0),
    kellyFullUsed: kellyFull,
    reason: "ok",
  };
}

export function formatStakeLineForTelegram(alert) {
  const { stakeUsdRounded } = computeStakeFromAlert(alert);
  if (stakeUsdRounded <= 0) return "Stake: $0 • PASS";
  const frac = toNumber(process.env.KELLY_FRACTION);
  const fracTxt = Number.isFinite(frac) && frac > 0 ? `Kelly ${frac}` : "Kelly";
  return `Stake: $${stakeUsdRounded} (${fracTxt})`;
}
