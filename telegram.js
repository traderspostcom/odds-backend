// telegram.js
import fetch from "node-fetch";

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

/**
 * Send a message to Telegram
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
        parse_mode: "Markdown"
      })
    });

    if (!res.ok) {
      console.error("❌ Telegram send failed:", await res.text());
    } else {
      console.log("📨 Telegram alert sent!");
    }
  } catch (err) {
    console.error("❌ Telegram send error:", err);
  }
}

/**
 * Normalize and map API market keys
 */
function mapMarketKey(market) {
  const norm = market.toLowerCase().replace(/[_\-\s]/g, "");
  switch (true) {
    case norm === "h2h":
    case norm === "h2h1st5innings":
      return "ML";
    case norm === "totals":
    case norm === "totals1st5innings":
      return "TOT";
    case norm === "spreads":
    case norm === "spreads1st5innings":
      return "SP";
    case norm === "teamtotals":
    case norm === "teamtotals1st5innings":
      return "TT";
    default:
      return market.toUpperCase();
  }
}

/**
 * Format a batch of sharp alerts into nice Telegram messages
 */
export function formatSharpBatch(games) {
  return games.map((g) => {
    const marketLabel = mapMarketKey(g.market);
    const holdText = g.hold !== null ? `💰 Hold: ${(g.hold * 100).toFixed(2)}%` : "";

    // Handle game time in ET
    const gameTime = g.time || g.commence_time || null;
    let displayTime = "TBD";
    if (gameTime) {
      try {
        const dt = new Date(gameTime);
        const options = {
          hour: "numeric",
          minute: "2-digit",
          timeZone: "America/New_York"
        };
        displayTime = dt.toLocaleTimeString("en-US", options);
      } catch {
        displayTime = gameTime; // fallback to raw if parsing fails
      }
    }

    let msg = `📊 *GoSignals Sharp Alert!*\n\n`;
    msg += `📅 ${displayTime}\n`;
    msg += `⚔️ ${g.away} @ ${g.home}\n\n`;
    msg += `🎯 Market: ${marketLabel}\n\n`;

    if (g.best) {
      if (g.best.home) msg += `🏠 ${g.home}: *${g.best.home.book}* (${g.best.home.price})\n`;
      if (g.best.away) msg += `🛫 ${g.away}: *${g.best.away.book}* (${g.best.away.price})\n`;
      if (g.best.O) msg += `⬆️ Over ${g.best.O.point || ""}: *${g.best.O.book}* (${g.best.O.price})\n`;
      if (g.best.U) msg += `⬇️ Under ${g.best.U.point || ""}: *${g.best.U.book}* (${g.best.U.price})\n`;
      if (g.best.FAV) msg += `⭐ Fav ${g.best.FAV.point || ""}: *${g.best.FAV.book}* (${g.best.FAV.price})\n`;
      if (g.best.DOG) msg += `🐶 Dog ${g.best.DOG.point || ""}: *${g.best.DOG.book}* (${g.best.DOG.price})\n`;
    }

    if (holdText) msg += `\n${holdText}`;

    return msg.trim();
  });
}
