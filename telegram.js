import "dotenv/config";
import fetch from "node-fetch";

// Replace with your actual bot token & chat ID
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || "8283930472:AAFeSN3i8FA9n8H2_7MYOVBQroWJdmVtz7M";
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || "<YOUR_CHAT_ID>"; // you get this from getUpdates
const API_BASE = "https://odds-backend-oo4k.onrender.com/api/mlb";

// Helper to send a message
async function sendTelegramMessage(text) {
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: "Markdown" })
  });
}

// Fetch odds and push to Telegram
async function pushUpdates() {
  const endpoints = ["f5_scan?telegram=true", "game_scan?telegram=true"];

  for (const endpoint of endpoints) {
    const url = `${API_BASE}/${endpoint}`;
    const resp = await fetch(url);
    const data = await resp.json();

    let msg = `📊 *MLB ${endpoint.replace("_scan?telegram=true","").toUpperCase()} Update* \n\n`;

    for (const [key, games] of Object.entries(data)) {
      if (!Array.isArray(games)) continue;
      msg += `*${key.toUpperCase()}*:\n`;
      for (const g of games) {
        msg += `- ${g.away} @ ${g.home} (${g.time}) → ${g.market}\n`;
      }
      msg += `\n`;
    }

    await sendTelegramMessage(msg);
  }
}

pushUpdates().catch(err => console.error("Telegram push failed:", err));

