import "dotenv/config";

// Replace with your actual bot token & chat ID
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || "8283930472:AAFeSN3i8FA9n8H2_7MYOVBQroWJdmVtz7M";
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || "5459632524"; // you get this from getUpdates
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
// telegram.js
import fetch from "node-fetch";

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// -------------------- Formatter --------------------
export function formatSharpAlert(g) {
  let header = `📊 ${g.away} @ ${g.home}\n${new Date(g.time).toLocaleString("en-US", { timeZone: "America/New_York" })}`;

  let lines = [];

  if (g.market.includes("h2h") && g.best) {
    lines.push(`ML  ${g.away} ${g.best.away?.price || ""} ${g.best.away?.book || ""}`);
    lines.push(`    ${g.home} ${g.best.home?.price || ""} ${g.best.home?.book || ""}`);
  }

  if (g.market.includes("spreads") && g.best) {
    lines.push(`SP  ${g.away} ${g.best.DOG?.point || ""} ${g.best.DOG?.price || ""} ${g.best.DOG?.book || ""}`);
    lines.push(`    ${g.home} ${g.best.FAV?.point || ""} ${g.best.FAV?.price || ""} ${g.best.FAV?.book || ""}`);
  }

  if (g.market.includes("totals") && g.best) {
    lines.push(`TOT O${g.best.O?.point || ""} ${g.best.O?.price || ""} ${g.best.O?.book || ""}`);
    lines.push(`    U${g.best.U?.point || ""} ${g.best.U?.price || ""} ${g.best.U?.book || ""}`);
  }

  return `\`\`\`\n${header}\n\n${lines.join("\n")}\n\`\`\``;
}

// -------------------- Telegram Sender --------------------
export async function sendTelegramMessage(message) {
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: CHAT_ID,
      text: message,
      parse_mode: "MarkdownV2"
    }),
  });

  if (!res.ok) {
    console.error("❌ Telegram error:", await res.text());
  }
}

