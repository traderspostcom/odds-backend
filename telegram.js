// --- helpers -------------------------------------------------
function toET(isoOrMs) {
  try {
    const dt = new Date(isoOrMs);
    return dt.toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      timeZone: "America/New_York",
    });
  } catch {
    return "TBD";
  }
}

function mapMarketKey(market) {
  const norm = String(market).toLowerCase().replace(/[_\-\s]/g, "");
  if (norm === "h2h" || norm === "h2h1st5innings") return "Moneyline (ML)";
  if (norm === "spreads" || norm === "spreads1st5innings") return "Spread (SP)";
  if (norm === "totals" || norm === "totals1st5innings") return "Total (TOT)";
  if (norm === "teamtotals" || norm === "teamtotals1st5innings") return "Team Total (TT)";
  return market.toUpperCase();
}

function fmtPrice(p) {
  if (p == null) return "";
  const n = Number(p);
  return Number.isFinite(n) && n > 0 ? `+${n}` : String(p);
}

function strongBadge(sharpLabel) {
  if (!sharpLabel) return "";
  if (/strong/i.test(sharpLabel)) return " ⭐ *Strong*";
  if (/lean/i.test(sharpLabel))   return " 🟢 *Lean*";
  return ` (${sharpLabel})`;
}

// --- pretty formatter ---------------------------------------
export function formatSharpBatch(games) {
  const divider = "────────────────────────";

  return games.map((g, i) => {
    const when = toET(g.time || g.commence_time);
    const marketLabel = mapMarketKey(g.market);
    const holdText = typeof g.hold === "number" ? `\n\n💰 Hold: ${(g.hold * 100).toFixed(2)}%` : "";
    const badge = strongBadge(g.sharpLabel);

    // build “best lines” block in a consistent order
    const lines = [];
    if (g.best) {
      if (g.best.home)
        lines.push(`🏠 ${g.home}: *${g.best.home.book}* (${fmtPrice(g.best.home.price)})`);
      if (g.best.away)
        lines.push(`🛫 ${g.away}: *${g.best.away.book}* (${fmtPrice(g.best.away.price)})`);
      if (g.best.FAV)
        lines.push(`⭐ Fav ${g.best.FAV.point ?? ""}: *${g.best.FAV.book}* (${fmtPrice(g.best.FAV.price)})`);
      if (g.best.DOG)
        lines.push(`🐶 Dog ${g.best.DOG.point ?? ""}: *${g.best.DOG.book}* (${fmtPrice(g.best.DOG.price)})`);
      if (g.best.O)
        lines.push(`⬆️ Over ${g.best.O.point ?? ""}: *${g.best.O.book}* (${fmtPrice(g.best.O.price)})`);
      if (g.best.U)
        lines.push(`⬇️ Under ${g.best.U.point ?? ""}: *${g.best.U.book}* (${fmtPrice(g.best.U.price)})`);
    }

    let msg = "";
    if (i > 0) msg += `\n${divider}\n`;                 // visual separator between alerts
    msg += `📊 *GoSignals Sharp Alert!*${badge}\n\n`;   // title
    msg += `🕘 ${when}\n`;                              // time ET
    msg += `⚔️ ${g.away} @ ${g.home}\n\n`;             // matchup
    msg += `🎯 Market: ${marketLabel}\n\n`;             // market label
    if (lines.length) msg += lines.join("\n");          // best lines
    msg += holdText;                                    // hold % if present
    return msg.trim();
  });
}
