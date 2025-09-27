// telegram.js (root) — Russ layout (blank lines) + Best-lines + Splits + Stake + Play-to (above EV)
// Quiet-hours gating (ET) + per-call bypass via sendTelegramMessage(text, { force:true }).

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
  if (start === null || end === null) return false;
  const t = now.getHours() * 60 + now.getMinutes();
  if (start <= end) return t >= start && t < end;   // same day
  return t >= start || t < end;                     // overnight
}
function shouldBlockTelegramSend() {
  if (process.env.QUIET_FORCE === "1") return false;             // global override
  if (process.env.QUIET_HOURS_BLOCK_SEND !== "true") return false;
  const start = process.env.QUIET_HOURS_START_ET || "21:00";
  const end   = process.env.QUIET_HOURS_END_ET   || "10:00";
  return isWithinQuietHoursET(start, end);
}

/* ---------------------- Robust fetch (Node 18/20/22) ---------------------- */
async function doFetch(url, options) {
  const f = globalThis.fetch ?? (await import("node-fetch")).default;
  return f(url, options);
}

/* ---------------------- Telegram send ---------------------- */
const TELEGRAM_TOKEN   = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

/**
 * Send a Telegram message.
 * @param {string} text
 * @param {{force?: boolean}} [opts] - if force===true, bypass quiet-hours for this call
 */
export async function sendTelegramMessage(text, opts = {}) {
  const force = !!opts.force;

  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
    console.error("❌ Telegram not configured (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID)");
    return;
  }
  if (!force && shouldBlockTelegramSend()) {
    const now = nowInET().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
    console.log(`🔕 Quiet hours active at ${now} ET — message suppressed.`);
    return;
  }
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  try {
    const res = await doFetch(url, {
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
      console.error("❌ Telegram send failed:", await res.text?.());
    } else {
      console.log("📨 Telegram alert sent!");
    }
  } catch (err) {
    console.error("❌ Telegram send error:", err);
  }
}

export function sendTelegramMessageForced(text) {
  return sendTelegramMessage(text, { force: true });
}

/* ---------------------- Odds helpers ---------------------- */
function num(x) { const n = Number(x); return Number.isFinite(n) ? n : NaN; }
function americanToDecimal(american) {
  const a = num(american);
  if (!Number.isFinite(a)) return NaN;
  if (a >= 100) return 1 + a / 100;
  if (a <= -100) return 1 + 100 / Math.abs(a);
  return NaN;
}
// Kelly fraction k = (d*p - 1) / (d - 1)
function kellyFromProbAndPrice(p, americanPrice) {
  const pNum = num(p);
  const d = americanToDecimal(americanPrice);
  if (!Number.isFinite(pNum) || !Number.isFinite(d) || d <= 1) return NaN;
  return (d * pNum - 1) / (d - 1);
}

/* ---------------------- Play-to helpers ---------------------- */
functi
