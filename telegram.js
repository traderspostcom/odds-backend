// src/telegram.js
import fetch from "node-fetch";

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

/* -------------------- Send Message (HTML mode) -------------------- */
export async function sendTelegramMessage(message) {
  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: message,
        parse_mode: "HTML",
        disable_web_page_preview: true
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

/* -------------------- Market Key Mapper -------------------- */
function mapMarketKey(market) {
  const norm = (market || "").toLowerCase().replace(/[_\-\s]/g, "");
  if (norm === "h2h" || norm === "h2h1st5innings") return "ML";
  if (norm === "totals" || norm === "totals1st5innings") return "TOT";
  if (norm === "spreads" || norm === "spreads1st5innings") return "SP";
  if (norm === "teamtotals" || norm === "teamtotals1st5innings") return "TT";
  return (market || "").toUpperCase();
}

/* -------------------- Pretty Card-Style Formatter -------------------- */
export function formatSharpBatch(games) {
  return games.map((g) => {
    const market = mapMarketKey(g.market);
    const gameTimeISO = g.time || g.commence_time || null;

    // format time in ET
    let timeEt = "TBD";
    if (gameTimeISO) {
      try {
        const dt = new Date(gameTimeISO);
        timeEt = dt.toLocaleTimeString("en-US", {
          hour: "numeric",
          minute: "2-digit",
          timeZone: "America/New_York"
        });
      } catch { /* noop */ }
    }

    // optional “(Lean/Strong)” if provided upstream
    const sharp = g.sharpLabel ? ` (${g.sharpLabel})` : "";

    // build best-price lines
    const lines = [];
    if (g.best?.home) lines.push(`🏠 <b>${g.home}</b>: <b>${g.best.home.book}</b> (${g.best.home.price})`);
    if (g.best?.away) lines.push(`🛫 <b>${g.away}</b>: <b>${g.best.away.book}</b> (${g.best.away.price})`);
    if (g.best?.FAV)  lines.push(`⭐ Fav ${g.best.FAV.point ?? ""}: <b>${g.best.FAV.book}</b> (${g.best.FAV.price})`);
    if (g.best?.DOG)  lines.push(`🐶 Dog ${g.best.DOG.point ?? ""}: <b>${g.best.DOG.book}</b> (${g.best.DOG.price})`);
    if (g.best?.O)    lines.push(`⬆️ Over ${g.best.O.point ?? ""}: <b>${g.best.O.book}</b> (${g.best.O.price})`);
    if (g.best?.U)    lines.push(`⬇️ Under ${g.best.U.point ?? ""}: <b>${g.best.U.book}</b> (${g.best.U.price})`);

    const hold = (typeof g.hold === "number")
      ? `\n💰 Hold: <b>${(g.hold * 100).toFixed(2)}%</b>`
      : "";

    const th = (typeof g.tickets === "number" && typeof g.handle === "number")
      ? `\n📈 Tickets: ${g.tickets}% | Handle: ${g.handle}%`
      : "";

    const header =
      `📊 <b>GoSignals Sharp Alert${sharp}!</b>\n\n` +
      `🕘 ${timeEt}\n` +
      `⚔️ ${g.away} @ ${g.home}\n\n` +
      `🎯 Market: <b>${market}</b>\n\n`;

    const body = lines.length ? lines.join("\n") + hold + th : "No priced books available.";

    return header + body;
  });
}
