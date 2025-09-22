// telegram.js

/**
 * Maps API market keys to human-readable short labels
 */
function mapMarketKey(market) {
  switch (market.toLowerCase()) {
    case "h2h":
    case "h2h_1st_5_innings":
      return "ML";
    case "totals":
    case "totals_1st_5_innings":
      return "TOT";
    case "spreads":
      return "SP";
    case "team_totals":
      return "TT";
    default:
      return market.toUpperCase();
  }
}

/**
 * Format a batch of sharp alerts into nice Telegram messages.
 */
export function formatSharpBatch(games) {
  return games.map((g) => {
    const marketLabel = mapMarketKey(g.market);
    const holdText = g.hold !== null ? `💰 Hold: ${(g.hold * 100).toFixed(2)}%` : "";

    let msg = `📊 *GoSignals Sharp Alert!*\n\n`;
    msg += `📅 ${g.time || "TBD"}\n`;
    msg += `⚔️ ${g.away} @ ${g.home}\n\n`;
    msg += `🎯 Market: ${marketLabel}\n`;

    if (g.best) {
      if (g.best.home) msg += `🏠 ${g.home}: ${g.best.home.book} (${g.best.home.price})\n`;
      if (g.best.away) msg += `🛫 ${g.away}: ${g.best.away.book} (${g.best.away.price})\n`;
      if (g.best.O) msg += `⬆️ Over ${g.best.O.point || ""}: ${g.best.O.book} (${g.best.O.price})\n`;
      if (g.best.U) msg += `⬇️ Under ${g.best.U.point || ""}: ${g.best.U.book} (${g.best.U.price})\n`;
      if (g.best.FAV) msg += `⭐ Fav ${g.best.FAV.point || ""}: ${g.best.FAV.book} (${g.best.FAV.price})\n`;
      if (g.best.DOG) msg += `🐶 Dog ${g.best.DOG.point || ""}: ${g.best.DOG.book} (${g.best.DOG.price})\n`;
    }

    if (holdText) msg += `\n${holdText}`;

    return msg;
  });
}
