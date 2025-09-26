// src/telegram.js — ESM, includes bankroll stake line, Play-to line, and plain "Away:" matchup

import fetch from "node-fetch";
import { formatStakeLineForTelegram } from "./utils/stake.js";
import { formatPlayToLineML } from "./utils/playto.js";

const TELEGRAM_TOKEN   = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

export async function sendTelegramMessage(text) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
    console.error("❌ Telegram not configured (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID)");
    return;
  }
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text,
        parse_mode: "Markdown",
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

function mapMarketKey(market) {
  const norm = String(market || "").toLowerCase().replace(/[_\-\s]/g, "");
  switch (true) {
    case norm === "h2h":                return "ML";
    case norm === "h2h1st5innings":     return "ML (F5)";
    case norm === "spreads":            return "SP";
    case norm === "spreads1st5innings": return "SP (F5)";
    case norm === "totals":             return "TOT";
    case norm === "totals1st5innings":  return "TOT (F5)";
    case norm === "teamtotals":         return "TT";
    default:                            return (market || "").toUpperCase();
  }
}

// helpers to infer fair probability for the picked side (best-effort, safe to fail)
function num(x) { const n = Number(x); return Number.isFinite(n) ? n : NaN; }
function inferPickedSide(g) {
  const sideField = String(g?.side || g?.sharp_side?.side || "").toLowerCase();
  if (sideField === "home" || sideField === "away") return sideField;
  if (g?.best?.away && !g?.best?.home) return "away";
  if (g?.best?.home && !g?.best?.away) return "home";
  return null;
}
function inferFairProbForPick(g) {
  const fh = num(g?.metrics?.fair_home ?? g?.fair_home);
  const fa = num(g?.metrics?.fair_away ?? g?.fair_away);
  const fp = num(g?.metrics?.fair_prob ?? g?.fair_prob);
  const side = inferPickedSide(g);

  if (side === "home") {
    if (Number.isFinite(fh)) return fh;
    if (Number.isFinite(fa)) return 1 - fa;
  }
  if (side === "away") {
    if (Number.isFinite(fa)) return fa;
    if (Number.isFinite(fh)) return 1 - fh;
  }
  if (Number.isFinite(fp)) return fp;
  return NaN;
}

/**
 * Formats an array of alert objects into Telegram-ready strings.
 * Each element in the returned array is a full message block.
 */
export function formatSharpBatch(alerts) {
  return (alerts || []).map(g => {
    const market = mapMarketKey(g.market);

    const gameTime = (() => {
      const t = g.time || g.commence_time;
      if (!t) return "TBD";
      try {
        return new Date(t).toLocaleTimeString("en-US", {
          hour: "numeric",
          minute: "2-digit",
          timeZone: "America/New_York"
        });
      } catch {
        return String(t);
      }
    })();

    const holdText  = (typeof g.hold === "number") ? ` • Hold ${(g.hold * 100).toFixed(1)}%` : "";
    const sharpText = g.sharpLabel ? ` *${g.sharpLabel}*` : "";

    // Best price/alt-line summary (if present)
    let best = "";
    if (g.best) {
      const seg = [];
      if (g.best.FAV)  seg.push(`⭐ Fav ${g.best.FAV.point ?? ""} — *${g.best.FAV.book}* (${g.best.FAV.price})`);
      if (g.best.DOG)  seg.push(`🐶 Dog ${g.best.DOG.point ?? ""} — *${g.best.DOG.book}* (${g.best.DOG.price})`);
      if (g.best.home) seg.push(`🏠 ${g.home} — *${g.best.home.book}* (${g.best.home.price})`);
      if (g.best.away) seg.push(`Away: ${g.away} — *${g.best.away.book}* (${g.best.away.price})`);
      if (g.best.O)    seg.push(`⬆️ Over ${g.best.O.point ?? ""} — *${g.best.O.book}* (${g.best.O.price})`);
      if (g.best.U)    seg.push(`⬇️ Under ${g.best.U.point ?? ""} — *${g.best.U.book}* (${g.best.U.price})`);
      if (seg.length) best = "\n" + seg.join("\n");
    }

    const splits = (typeof g.tickets === "number" && typeof g.handle === "number")
      ? `\n📈 Tickets ${g.tickets}% | Handle ${g.handle}%` : "";

    // Build message lines (plain-text matchup as requested)
    const lines = [
      `📊 *GoSignals*${sharpText}`,
      `🕒 ${gameTime}  •  🎯 ${market}${holdText}`,
      `Away: ${g.away} @ ${g.home}`,
      best,
      splits
    ].filter(Boolean);

    // Stake line (bankroll mode)
    const stakeLine = formatStakeLineForTelegram(g);
    if (stakeLine) lines.push(stakeLine);

    // Play-to line (EV ≥ EV_MIN_FOR_PLAYTO; default 0 if unset)
    const pFair = inferFairProbForPick(g);
    const playToLine = Number.isFinite(pFair) ? formatPlayToLineML(pFair, process.env.EV_MIN_FOR_PLAYTO) : null;
    if (playToLine) lines.push(playToLine);

    return lines.join("\n").trim();
  });
}
