export function formatSharpAlert(game, marketType) {
  return `📊 Sharp Alert!\n\n${game.away} vs ${game.home}\nMarket: ${marketType}\nBest Line: ${JSON.stringify(game.best, null, 2)}`;
}

export async function sendTelegramMessage(message) {
  const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: CHAT_ID, text: message, parse_mode: "Markdown" }),
  });
}
