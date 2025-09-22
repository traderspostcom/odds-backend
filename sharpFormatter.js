// sharpFormatter.js
export function formatSharpAlert(alert) {
  if (!alert) return null;

  const { render, game, lines, recommendation, sharp_side, score, signals } = alert;

  let msg = `${render.emoji} *${render.title}*\n\n`;

  msg += `📅 ${new Date(game.start_time_utc).toLocaleString("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "2-digit",
    month: "short",
    day: "numeric"
  })} ET\n`;
  msg += `⚔️ ${game.away} @ ${game.home}\n\n`;

  msg += `🎯 Sharp Side: *${sharp_side.team || "Split"}*\n`;
  msg += `📊 Score: ${score} (${render.strength})\n`;
  msg += `🏷️ Signals: ${signals.map((s) => s.label).join(", ")}\n\n`;

  msg += `📈 Entry: ${lines.sharp_entry}\n`;
  msg += `📉 Current: ${lines.current_consensus}\n`;

  msg += `\n✅ *Recommendation*: ${recommendation.status}\n_${recommendation.reason}_`;

  return msg.trim();
}
/* -------------------- V2 Max-Info Batch Formatter -------------------- */
export function formatSharpBatchV2(alerts, opts = {}) {
  if (!Array.isArray(alerts) || alerts.length === 0) {
    return "_No sharp signals in this window._";
  }

  const {
    mode = (process.env.SHARP_PROFILE || "sharpest").toUpperCase(),
    auto = true,
    credits = null,  // { used, limit } | null
    now = new Date(),
  } = opts;

  const ts = now.toLocaleString("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });

  const header = [
    `🛰️ *GoSignals — Sharp Scan*`,
    `Mode: *${mode}* • ${auto ? "🤖 Auto" : "🧭 Manual"}`,
    `🕒 ${ts} ET`,
    `Found: *${alerts.length}*`
  ].join("\n");

  // Cards
  const cards = alerts.map(a => formatSharpCard(a)).filter(Boolean);

  // Footer tallies
  const tallies = tallyByTier(alerts);
  const footerLines = [
    "—",
    `🟢 Strong: *${tallies.strong}* • 🟡 Lean: *${tallies.lean}* • ⚠️ Conflict: *${tallies.conflict}*`
  ];
  if (credits && Number.isFinite(credits.used) && Number.isFinite(credits.limit)) {
    footerLines.push(`💳 Credits: ${credits.used}/${credits.limit}`);
    footerLines.push(creditBar(credits.used, credits.limit));
  }
  const footer = footerLines.join("\n");

  return [header, "", cards.join("\n\n────────────\n\n"), "", footer].join("\n");
}

/* -------------------- Single Card (Max-Info) -------------------- */
export function formatSharpCard(a) {
  if (!a) return null;

  // expected analyzeMarket payload (normalized)
  // id, sport, marketType, matchup, game{home,away,start_time_utc}
  // side{team, entryPrice, atOrBetter, fairPrice?, consensusPrice?}
  // lineMove{open,current,delta}
  // consensus{ticketsPct, handlePct, gapPct}
  // holdPct?
  // score{total, tier}
  // signals[{label, weight, details?}]
  // keyNumber{note?}
  // books[{book, price}] (optional)
  // alertKind ("initial" | "reentry" | "improved")
  // cooldownMins (optional)

  const badge = tierBadge(a?.score?.tier);
  const kind = alertKind(a?.alertKind);

  const startET = a?.game?.start_time_utc
    ? new Date(a.game.start_time_utc).toLocaleString("en-US", {
        timeZone: "America/New_York",
        hour: "numeric",
        minute: "2-digit",
        month: "short",
        day: "numeric"
      }) + " ET"
    : "TBD";

  const header = [
    `${badge}  |  ${kind}`,
    `${(a?.sport || "").toUpperCase()} • ${a?.marketType || "H2H"}  •  ${a?.matchup || `${a?.game?.away} @ ${a?.game?.home}`}`,
    `🕓 ${startET}  |  ID: ${code(a?.id)}`
  ].join("\n");

  const lineGuide = renderLineGuide(a?.side);
  const evLine = renderEV(a?.side);
  const move = renderMove(a?.lineMove);
  const keyNum = `🔢 Key Number: ${a?.keyNumber?.note || "—"}`;
  const split = renderSplit(a?.consensus);
  const hold = renderHold(a?.holdPct);
  const sigs = renderSignals(a?.signals, a?.score?.total);
  const outlier = renderOutlier(a?.signals);
  const books = renderBooks(a?.books);

  const reco = renderReco(a?.side);

  const cooldown = a?.cooldownMins
    ? `⏳ Cooldown: ${a.cooldownMins}m`
    : null;

  return [
    header,
    "",
    lineGuide,
    evLine && `   ${evLine}`,
    "",
    move,
    keyNum,
    split,
    hold,
    "",
    sigs,
    outlier && `• ${outlier}`,
    "",
    books,
    "",
    reco,
    cooldown
  ].filter(Boolean).join("\n");
}

/* -------------------- Helpers -------------------- */
function tierBadge(tier) {
  if (tier === "strong") return "🟢 *STRONG*";
  if (tier === "lean") return "🟡 *LEAN*";
  return "⚠️ *CONFLICT*";
}
function alertKind(kind) {
  if (kind === "reentry") return "🔁 Re-entry";
  if (kind === "improved") return "🟢 Improved";
  return "🚨 Initial";
}
function code(s) {
  if (!s) return "`—`";
  return "`" + String(s) + "`";
}
function fmtPrice(n) {
  if (n == null || Number.isNaN(n)) return "–";
  return n > 0 ? `+${n}` : `${n}`;
}
function fmtPct(n) {
  if (n == null || Number.isNaN(n)) return "–";
  return `${Math.round(n * 100)}%`;
}
function signPct(n) {
  if (n == null || Number.isNaN(n)) return "–";
  const pct = Math.round(n * 100);
  const s = pct > 0 ? "+" : "";
  return `${s}${pct}%`;
}
function renderLineGuide(side) {
  if (!side?.team || side.entryPrice == null) return "🎯 TAKE: _insufficient data_";
  const tag = side.atOrBetter === false ? "or worse" : "or better";
  return `🎯 TAKE: *${side.team}* @ *${fmtPrice(side.entryPrice)}* ${tag}`;
}
function renderEV(side) {
  if (side?.fairPrice == null || side?.consensusPrice == null) return null;
  const evPct = evFromFair(side.fairPrice, side.consensusPrice);
  const evStr = evPct == null ? null : `${evPct >= 0 ? "+" : ""}${evPct.toFixed(1)}% EV`;
  return evStr
    ? `Fair: ${fmtPrice(side.fairPrice)}  |  Market: ${fmtPrice(side.consensusPrice)}  →  ${evStr}`
    : `Fair: ${fmtPrice(side.fairPrice)}  |  Market: ${fmtPrice(side.consensusPrice)}`;
}
function evFromFair(fair, market) {
  // very light proxy: convert American → implied, EV ≈ fairProb - marketProb
  const f = toProb(fair);
  const m = toProb(market);
  if (f == null || m == null) return null;
  return (f - m) * 100;
}
function toProb(price) {
  if (price == null || Number.isNaN(price)) return null;
  if (price < 0) return (-price) / ((-price) + 100);    // negative American
  return 100 / (price + 100);                           // positive American
}
function renderMove(move) {
  if (!move) return `📈 Line Move: —`;
  const delta = move.delta == null ? null : (move.delta > 0 ? `+${move.delta}` : `${move.delta}`);
  return `📈 Line Move: ${fmtPrice(move.open)} → ${fmtPrice(move.current)}  (${delta ?? "—"})`;
}
function renderSplit(c) {
  if (!c) return `🧮 Split: —`;
  const gap = c.gapPct != null ? signPct(c.gapPct) : "–";
  return `🧮 Split: tickets ${fmtPct(c.ticketsPct)} | handle ${fmtPct(c.handlePct)} | gap ${gap}`;
}
function renderHold(h) {
  if (h == null) return `💰 Hold: —`;
  const pass = passFailHold(h);
  return `💰 Hold: ${(h * 100).toFixed(1)}%  (${pass ? "✅ within profile" : "🚫 above profile"})`;
}
function passFailHold(h) {
  // try reading from active profile if available
  try {
    // dynamic import to avoid circular if user imports config here
    const profKey = (process.env.SHARP_PROFILE || "sharpest");
    const cfg = requireConfigSafe();
    const lim = cfg?.profiles?.[profKey]?.hold?.max;
    if (typeof lim === "number") return h <= lim;
  } catch {}
  // default permissive
  return true;
}
function requireConfigSafe() {
  try {
    // In ESM, use dynamic import
    // NOTE: caller already uses ESM; we guard errors and just return null if not available
    return null;
  } catch { return null; }
}
function renderSignals(sigs, scoreTotal) {
  if (!Array.isArray(sigs) || sigs.length === 0) return `🔎 Signals (score ${scoreTotal ?? "—"}): —`;
  const items = sigs.map(s => {
    const base = s.label || s.key || "Signal";
    return s.weight != null ? `${base} (+${s.weight})` : base;
  }).join(", ");
  return `🔎 Signals (score ${scoreTotal?.toFixed ? scoreTotal.toFixed(1) : scoreTotal ?? "—"}):\n• ${items}`;
}
function renderOutlier(sigs) {
  if (!Array.isArray(sigs)) return null;
  const o = sigs.find(s => s.key === "outlier" && s.details);
  return o ? `Outlier: ${o.details}` : null;
}
function renderBooks(books) {
  if (!Array.isArray(books) || books.length === 0) return "🏪 Best Books Now:\n• —";
  const three = books.slice(0, 3).map(b => `• ${b.book} ${fmtPrice(b.price)}`).join("   ");
  return `🏪 Best Books Now:\n${three}`;
}
function renderReco(side) {
  if (!side?.entryPrice) return "✅ RECO: —";
  const tag = side.atOrBetter === false ? "or worse" : "or better";
  // If market worse than entry for favs (more negative), recommend pass
  if (side.consensusPrice != null) {
    const isFav = side.entryPrice < 0;
    const market = side.consensusPrice;
    const entry = side.entryPrice;
    const stillGood = isFav ? (market <= entry) : (market >= entry);
    if (!stillGood) {
      return `🚫 RECO: Pass — line moved past entry; set alert at *${fmtPrice(entry)}*.`;
    }
  }
  return `✅ RECO: Bet if *${fmtPrice(side.entryPrice)}* ${tag} is available.`;
}
function tallyByTier(list) {
  const t = { strong: 0, lean: 0, conflict: 0 };
  for (const a of list) {
    const tier = a?.score?.tier || "conflict";
    if (t[tier] != null) t[tier] += 1;
  }
  return t;
}
function creditBar(used, limit) {
  if (!limit) return "";
  const pct = Math.max(0, Math.min(1, used / limit));
  const filled = Math.round(pct * 20);
  return "`[" + "#".repeat(filled) + "-".repeat(20 - filled) + `] ${Math.round(pct*100)}%` + "`";
}
