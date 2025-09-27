// telegram.js (root) — Formats exactly per Russ’s sample, with blank lines.
// Quiet-hours (ET) gating included. Shows Kelly % line; NO Stake/Play-to lines.

//
// ---------------------- Quiet-hours (ET) ----------------------
function parseHHMM(s) {
  if (!s || typeof s !== "string") return null;
  const m = s.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]), min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}
function nowInET() {
  return new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
}
function isWithinQuietHoursET(startHHMM, endHHMM, now = nowInET()) {
  const start = parseHHMM(startHHMM);
  const end = parseHHMM(endHHMM);
  if (start === null || end === null) return false;
  const t = now.getHours() * 60 + now.getMinutes();
  if (start <= end) return t >= start && t < end;   // same day
  return t >= start || t < end;                     // overnight
}
function shouldBlockTelegramSend() {
  if (process.env.QUIET_FORCE === "1") return false;
  if (process.env.QUIET_HOURS_BLOCK_SEND !== "true") return false;
  const start = process.env.QUIET_HOURS_START_ET || "21:00";
  const end   = process.env.QUIET_HOURS_END_ET   || "10:00";
  return isWithinQuietHoursET(start, end);
}

// ---------------------- Robust fetch (Node 18/20/22) ----------------------
async function doFetch(url, options) {
  const f = globalThis.fetch ?? (await import("node-fetch")).default;
  return f(url, options);
}

// ---------------------- Telegram send ----------------------
const TELEGRAM_TOKEN   = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

export async function sendTelegramMessage(text) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
    console.error("❌ Telegram not configured (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID)");
    return;
  }
  if (shouldBlockTelegramSend()) {
    const now = nowInET().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
    console.log(`🔕 Quiet hours active at ${now} ET — message suppressed.`);
    return;
  }
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  try {
    const res = await doFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text,
        parse_mode: "Markdown",
        disable_web_page_preview: true
      })
    });
    if (!res.ok) {
      console.error("❌ Telegram send failed:", await res.text?.());
    } else {
      console.log("📨 Telegram alert sent!");
    }
  } catch (err) {
    console.error("❌ Telegram send error:", err);
  }
}

// ---------------------- Formatting helpers ----------------------
function mapMarketKey(market) {
  const norm = String(market || "").toLowerCase().replace(/[_\-\s]/g, "");
  switch (true) {
    case norm === "h2h":                return "ML";
    case norm === "h2h1st5innings":     return "ML (F5)";
    case norm === "spreads":            return "SP";
    case norm === "spreads1st5innings": return "SP (F5)";
    case norm === "totals":             return "TOT";
    case norm === "totals1st5innings":  return "TOT (F5)";
    case norm === "teamtotals":         return "TT";
    default:                            return (market || "").toUpperCase();
  }
}
function num(x) { const n = Number(x); return Number.isFinite(n) ? n : NaN; }
function americanToDecimal(american) {
  const a = num(american);
  if (!Number.isFinite(a)) return NaN;
  if (a >= 100) return 1 + a / 100;
  if (a <= -100) return 1 + 100 / Math.abs(a);
  return NaN;
}
// Kelly fraction k = (d*p - 1) / (d - 1)
function kellyFromProbAndPrice(p, americanPrice) {
  const pNum = num(p);
  const d = americanToDecimal(americanPrice);
  if (!Number.isFinite(pNum) || !Number.isFinite(d) || d <= 1) return NaN;
  return (d * pNum - 1) / (d - 1);
}
function inferPickedSide(g) {
  const sideField = String(g?.side || g?.sharp_side?.side || "").toLowerCase();
  if (sideField === "home" || sideField === "away") return sideField;
  if (g?.best?.away && !g?.best?.home) return "away";
  if (g?.best?.home && !g?.best?.away) return "home";
  return null;
}
function inferFairProbForPick(g) {
  const fh = num(g?.metrics?.fair_home ?? g?.fair_home);
  const fa = num(g?.metrics?.fair_away ?? g?.fair_away);
  const fp = num(g?.metrics?.fair_prob ?? g?.fair_prob);
  const side = inferPickedSide(g);
  if (side === "home") { if (Number.isFinite(fh)) return fh; if (Number.isFinite(fa)) return 1 - fa; }
  if (side === "away") { if (Number.isFinite(fa)) return fa; if (Number.isFinite(fh)) return 1 - fh; }
  if (Number.isFinite(fp)) return fp;
  return NaN;
}
function formatDateTimeET(iso) {
  if (!iso) return "TBD";
  const d = new Date(iso);
  const dt = new Date(d.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const mon = dt.toLocaleString("en-US", { month: "short" });
  const day = dt.getDate();
  const tm  = dt.toLocaleString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
  return `${mon} ${day}, ${tm}`;
}
function pickLine(g) {
  const side = inferPickedSide(g) || "away";
  const team = side === "home" ? g.home : g.away;
  const best = side === "home" ? g?.best?.home : g?.best?.away;
  const price = best?.price ?? g?.price ?? g?.lines?.sharp_entry;
  const book  = (best?.book || g?.lines?.book || "").toString().toLowerCase();
  const sign  = Number(price) > 0 ? "+" : "";
  return `🎯 Pick: ${team} (${side}) @ ${sign}${price}${book ? " on " + book : ""}`;
}
function evPercentFrom(g) {
  const ev1 = num(g?.metrics?.ev_pct ?? g?.ev_pct ?? g?.ev);
  if (Number.isFinite(ev1)) return ev1 * 100;
  const p = inferFairProbForPick(g);
  const side = inferPickedSide(g);
  const price = side === "home" ? g?.best?.home?.price : g?.best?.away?.price;
  if (Number.isFinite(p) && Number.isFinite(Number(price))) {
    const am = Number(price);
    const dec = am >= 100 ? 1 + am / 100 : 1 + 100 / Math.abs(am);
    return (dec * p - 1) * 100;
  }
  return NaN;
}
function edgePercentFrom(g) {
  const edge = num(g?.metrics?.edge_pct ?? g?.edge_pct);
  return Number.isFinite(edge) ? edge * 100 : NaN;
}
function kellyLineFromEnvAndAlert(g) {
  // Prefer explicit kellyFull; else metrics.kelly in [0,1]; else derive from p & price
  let kFull = num(g?.metrics?.kellyFull);
  if (!Number.isFinite(kFull)) {
    const kMaybe = num(g?.metrics?.kelly);
    if (Number.isFinite(kMaybe) && kMaybe >= 0 && kMaybe <= 1) kFull = kMaybe;
  }
  if (!Number.isFinite(kFull)) {
    const p = inferFairProbForPick(g);
    const side = inferPickedSide(g);
    const price = side === "home" ? g?.best?.home?.price : g?.best?.away?.price;
    if (Number.isFinite(p) && Number.isFinite(Number(price))) {
      kFull = kellyFromProbAndPrice(p, Number(price));
    }
  }
  if (!Number.isFinite(kFull) || kFull <= 0) return null;

  // Fraction display using env (no stake output; just percentages & cap)
  const frac = num(process.env.KELLY_FRACTION);
  const bank = num(process.env.BANKROLL_USD);
  const cap  = num(process.env.KELLY_MAX_USD);

  const pctFull = kFull * 100;
  const pctFrac = Number.isFinite(frac) ? pctFull * Math.max(0, Math.min(1, frac)) : NaN;

  const fracSymbol = (v) => (Math.abs(v - 0.5) < 1e-3 ? "½"
                    : Math.abs(v - 0.25) < 1e-3 ? "¼"
                    : Math.abs(v - 0.33) < 0.02 ? "⅓"
                    : Number.isFinite(v) ? `×${(+v).toFixed(2)}` : "");

  const parts = [];
  parts.push(`Kelly ${pctFull.toFixed(1)}%`);
  if (Number.isFinite(pctFrac) && frac > 0) parts.push(`${fracSymbol(frac)} ${pctFrac.toFixed(1)}%`);
  if (Number.isFinite(cap) && Number.isFinite(bank) && bank > 0) {
    const capPct = (cap / bank) * 100;
    parts.push(`(cap ${capPct.toFixed(1)}%)`);
  }
  return `💵 ${parts.join(" / ")}`;
}

// ---------------------- Public: format batch (matches Russ’s layout) ----------------------
export function formatSharpBatch(alerts) {
  return (alerts || []).map(g => {
    const market = mapMarketKey(g.market);
    const strength = (g?.render?.strength || g?.sharpLabel || "").trim(); // e.g., "🟡 Lean"
    const when = formatDateTimeET(g.time || g.commence_time);
    const matchup = `${g.away} @ ${g.home}`;
    const pick = pickLine(g);

    const evPct = evPercentFrom(g);
    const evLine = Number.isFinite(evPct) ? `📈 ${(evPct >= 0 ? "+" : "")}${evPct.toFixed(2)}% EV` : null;

    const edgePct = edgePercentFrom(g);
    const edgeLine = Number.isFinite(edgePct) ? `📊 Edge ${edgePct.toFixed(2)}%` : null;

    const kLine = kellyLineFromEnvAndAlert(g);

    // Build with blank lines exactly like the sample
    const sections = [
      "🚨 GoSignals Alert",
      `${market}  ${strength}`.trim(),
      `🕒 ${when}\n${matchup}`,
      pick,
      evLine,
      edgeLine,
      kLine
    ].filter(Boolean);

    return sections.join("\n\n").trim();
  });
}
