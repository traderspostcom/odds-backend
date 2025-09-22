// telegram.js
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

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
        parse_mode: "Markdown" // ✅ allows bold, italics, emojis
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
 */
export function formatSharpAlert(game, marketType) {
  const { home, away, time, best } = game;

  return (
    `📊 *Sharp Alert!*\n\n` +
    `🕒 ${time || "TBD"}\n` +
    `⚔️ ${away} vs ${home}\n` +
    `🎯 Market: ${marketType}\n\n` +
    `🏠 Home: ${best?.home ? `${best.home.book} (${best.home.price})` : "N/A"}\n` +
    `🛫 Away: ${best?.away ? `${best.away.book} (${best.away.price})` : "N/A"}`
  );
}

