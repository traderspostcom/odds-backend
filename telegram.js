// src/telegram.js — ESM, bankroll Stake + Play-to + backend quiet-hours

import fetch from "node-fetch";
import { formatStakeLineForTelegram } from "./utils/stake.js";
import { formatPlayToLineML } from "./utils/playto.js";

const TELEGRAM_TOKEN   = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// -------- Quiet-hours helpers (ET) --------
function parseHHMM(s) {
  if (!s || typeof s !== "string") return null;
  const m = s.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]), min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

function nowInET() {
  // Convert "now" into an ET Date object
  return new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
}

function isWithinQuietHoursET(startHHMM, endHHMM, now = nowInET()) {
  const start = parseHHMM(startHHMM);
  const end = parseHHMM(endHHMM);
  if (start === null || end === null) return false; // not configured => not quiet

  const t = now.getHours() * 60 + now.getMinutes();
  // normal window (e.g., 10:00 → 21:00)
  if (start <= end) return t >= start && t < end;
  // overnight window (e.g., 21:00 → 10:00 next day)
  return t >= start || t < end;
}

function shouldBlockTelegramSend() {
  if (process.env.QUIET_FORCE === "1") return false; // manual override
  if (process.env.QUIET_HOURS_BLOCK_SEND !== "true") return false;

  const start = process.env.QUIET_HOURS_START_ET || "21:00";
  const end   = process.env.QUIET_HOURS_END_ET   || "10:00";
  return isWithinQuietHoursET(start, end);
}

// -------- Telegram send --------
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
      console.error("❌ Telegram send failed:", awai
