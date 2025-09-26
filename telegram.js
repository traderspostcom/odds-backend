// telegram.js (root) — ESM. Adds bankroll Stake, Play-to line, and quiet-hours gating (ET).
// Relies on utils in ./src/utils/*.js

import fetch from "node-fetch";
import { formatStakeLineForTelegram } from "./src/utils/stake.js";
import { formatPlayToLineML } from "./src/utils/playto.js";

const TELEGRAM_TOKEN   = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

/* ---------------------- Quiet-hours (ET) ---------------------- */

function parseHHMM(s) {
  if (!s || typeof s !== "string") return null;
  const m = s.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]), min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

function nowInET() {
  return new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
}

function isWithinQuietHoursET(startHHMM, endHHMM, now = nowInET()) {
  const start = parseHHMM(startHHMM);
  const end = parseHHMM(endHHMM);
  if (start === null || end === null) return false; // not configured
  const t = now.getHours() * 60 + now.getMinutes();
  if (start <= end) return t >= start && t < end;   // same-day window
  return t >= start || t < end;                     // overnight window
}

function shouldBlockTelegramSend() {
  if (process.env.QUIET_FORCE === "1") return false;                 // manual override
  if (process.env.QUIET_HOURS_BLOCK_SEND !== "true") return false;   // off by default
  const start = process.env.QUIET_HOURS_START_ET || "21:00";
  const end   = process.env.QUIET_HOURS_END_ET   || "10:00";
  return isWithinQuietHoursET(start, end);
}

/* ---------------------- Telegram send ---------------------- */

export async function sendTelegramMessage(text) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
    console.error("❌ Telegram not configured (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID)");
    return;
  }
  if (shouldBlockTelegramSend()) {
    const now = nowInET().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
    console.log(`🔕 Quiet hours active at ${now} ET — message suppressed.`);
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

/* ---------------------- Formatting helpers ---------------------- */

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

// best-effort fair prob inference (for Play-to)
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

/* ---------------------- Public: format batch ---------------------- */

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
