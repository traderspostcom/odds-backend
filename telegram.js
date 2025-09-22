// telegram.js
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const SHARP_BOOKS = (process.env.SHARP_BOOKS || "")
  .split(",")
  .map(b => b.trim().toLowerCase());

/**
 * Sends a plain text message to Telegram.
 */
export async function sendTelegramMessage(message) {
  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: message,
        parse_mode: "Markdown" // ✅ bold, italics, emojis
      })
    });

    if (!res.ok) {
      console.error("❌ Telegram send failed:", await res.text());
    } else {
      console.log(`📨 Telegram alert sent: ${message}`);
    }
  } catch (err) {
    console.error("❌ Telegram send error:", err);
  }
}

/**
 * Formats a sharp betting alert for Telegram.
 * Includes H2H, Totals, Spreads, Team Totals
 */
export function formatSharpAlert(game, marketType) {
  const { home, away, time, best, hold } = game;

  let message = `📊 *GoSignals Sharp Alert!*\n\n`;
  message += `🕒 ${time || "TBD"}\n`;
  message += `⚔️ ${away} vs ${home}\n`;
  message += `🎯 Market: ${marketType.toUpperCase()}\n\n`;

  switch (marketType.toLowerCase()) {
    case "h2h":
    case "f5_h2h":
      message += `🏠 Home: ${best?.home ? `${best.home.book} (${best.home.price})` : "N/A"}\n`;
      message += `🛫 Away: ${best?.away ? `${best.away.book} (${best.away.price})` : "N/A"}`;
      break;

    case "totals":
    case "f5_totals":
      message += `⬆️ Over: ${best?.O ? `${best.O.book} ${best.O.point || ""} (${best.O.price})` : "N/A"}\n`;
      message += `⬇️ Under: ${best?.U ? `${best.U.book} ${best.U.point || ""} (${best.U.price})` : "N/A"}`;
      break;

    case "spreads":
      message += `⭐ Favorite: ${best?.FAV ? `${best.FAV.book} ${best.FAV.point || ""} (${best.FAV.price})` : "N/A"}\n`;
      message += `🐶 Underdog: ${best?.DOG ? `${best.DOG.book} ${best.DOG.point || ""} (${best.DOG.price})` : "N/A"}`;
      break;

    case "team_totals":
      message += `🏠 Home TT: ${best?.home ? `${best.home.book} ${best.home.point || ""} (${best.home.price})` : "N/A"}\n`;
      message += `🛫 Away TT: ${best?.away ? `${best.away.book} ${best.away.point || ""} (${best.away.price})` : "N/A"}`;
      break;

    default:
      message += `⚠️ No formatter for market type: ${marketType}`;
  }

  if (typeof hold === "number") {
    message += `\n\n💰 Hold: ${(hold * 100).toFixed(2)}%`;
  }

  return message;
}

/**
 * Batch formatter: sends multiple sharp hits as separate alerts
 */
export function formatSharpBatch(games) {
  return games.flatMap(g => {
    if (!g.market) return [];
    return [formatSharpAlert(g, g.market)];
  });
}
