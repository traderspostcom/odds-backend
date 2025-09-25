// src/telegram.js
import fetch from "node-fetch";

const TELEGRAM_TOKEN   = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

/* -------------------- utils -------------------- */
function esc(s) {
  // HTML escape for Telegram parse_mode=HTML
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function toET(isoLike) {
  if (!isoLike) return "TBD";
  try {
    const dt = new Date(isoLike);
    return dt.toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      timeZone: "America/New_York",
    });
  } catch {
    return String(isoLike);
  }
}

function mapMarketKey(market) {
  if (!market) return "—";
  const norm = market.toLowerCase().replace(/[_\-\s]/g, "");
  if (norm === "h2h" || norm === "h2h1st5innings") return "ML";
  if (norm === "totals" || norm === "totals1st5innings") return "TOT";
  if (norm === "spreads" || norm === "spreads1st5innings") return "SP";
  if (norm === "teamtotals" || norm === "teamtotals1st5innings") return "TT";
  return market.toUpperCase();
}

/* -------------------- sender -------------------- */
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
        disable_web_page_preview: true,
      }),
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

/* -------------------- formatter -------------------- */
export function formatSharpBatch(games) {
  return games.map((g) => {
    const market = mapMarketKey(g.market);
    const timeET = toET(g.time || g.commence_time);
    const sharp   = g.sharpLabel ? ` (${esc(g.sharpLabel)})` : "";

    // Optional numbers that may exist in your objects
    const edge  = (g.edge  != null) ? Number(g.edge).toFixed(2) : null;
    const ev    = (g.ev    != null) ? Number(g.ev).toFixed(2)   : null;
    const kelly = (g.kelly != null) ? Number(g.kelly).toFixed(2): null;

    const holdText = (g.hold != null)
      ? `💰 Hold: <b>${(g.hold * 100).toFixed(2)}%</b>`
      : "";

    let lines = [];

    // Headline
    lines.push(`📊 <b>GoSignals Sharp Alert${sharp}!</b>`);
    lines.push(`🕒 ${esc(timeET)}  •  🎯 Market: <b>${esc(market)}</b>`);
    lines.push(`⚔️ ${esc(g.away || "Away")} @ ${esc(g.home || "Home")}`);

    // Best lines block (all optional)
    if (g.best) {
      let best = [];
      if (g.best.home) best.push(`🏠 ${esc(g.home)}: <b>${esc(g.best.home.book)}</b> (${esc(g.best.home.price)})`);
      if (g.best.away) best.push(`🛫 ${esc(g.away)}: <b>${esc(g.best.away.book)}</b> (${esc(g.best.away.price)})`);
      if (g.best.O)    best.push(`⬆️ Over ${esc(g.best.O.point || "")}: <b>${esc(g.best.O.book)}</b> (${esc(g.best.O.price)})`);
      if (g.best.U)    best.push(`⬇️ Under ${esc(g.best.U.point || "")}: <b>${esc(g.best.U.book)}</b> (${esc(g.best.U.price)})`);
      if (g.best.FAV)  best.push(`⭐ Fav ${esc(g.best.FAV.point || "")}: <b>${esc(g.best.FAV.book)}</b> (${esc(g.best.FAV.price)})`);
      if (g.best.DOG)  best.push(`🐶 Dog ${esc(g.best.DOG.point || "")}: <b>${esc(g.best.DOG.book)}</b> (${esc(g.best.DOG.price)})`);
      if (best.length) {
        lines.push("");
        lines = lines.concat(best);
      }
    }

    // Edge/EV/Kelly (if available)
    if (edge || ev || kelly) {
      let parts = [];
      if (edge)  parts.push(`Edge: <b>${edge}%</b>`);
      if (ev)    parts.push(`EV: <b>${ev}</b>`);
      if (kelly) parts.push(`Kelly: <b>${kelly}</b>`);
      if (parts.length) lines.push("", `📈 ${parts.join("  •  ")}`);
    }

    // Public splits (if present)
    if (typeof g.tickets === "number" || typeof g.handle === "number") {
      const t = (typeof g.tickets === "number") ? `${g.tickets}%` : "—";
      const h = (typeof g.handle  === "number") ? `${g.handle}%`  : "—";
      lines.push(`👥 Tickets: <b>${t}</b>  •  Handle: <b>${h}</b>`);
    }

    // Hold
    if (holdText) lines.push(holdText);

    return lines.join("\n").trim();
  });
}
