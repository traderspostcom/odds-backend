// odds-cron/src/index.js
// Cloudflare Worker that pings your Render backend on schedule or via HTTP.
// Endpoints: /run (dry), /run-tg (force TG), /ping (health).
// Cron runs only 07:00–23:00 ET. Requires SCAN_KEY secret to match Render SCAN_KEY.

process.on("unhandledRejection", (err) => {
  console.error("unhandledRejection", String(err?.stack || err));
});
process.on("uncaughtException", (err) => {
  console.error("uncaughtException", String(err?.stack || err));
});
console.log("[boot] starting odds-backend", {
  node: process.version,
  cwd: process.cwd(),
  port: process.env.PORT || 3000,
});

const BACKEND = "https://odds-backend-oo4k.onrender.com";

/* ---------------------------- small helpers ---------------------------- */
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "content-type": "application/json" }
  });
}
function safeJSON(txt) { try { return JSON.parse(txt); } catch { return txt; } }

/** Is New York time within 07:00 → 23:00 (inclusive of exactly 23:00)? */
function isETOpen() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(now);
  const hh = Number(parts.find(p => p.type === "hour").value);
  const mm = Number(parts.find(p => p.type === "minute").value);
  if (hh < 7) return false;              // before 07:00 -> closed
  if (hh < 23) return true;              // 07:00..22:59 -> open
  return mm === 0;                       // exactly 23:00 -> open, 23:01+ -> closed
}

/** fetch with timeout that works on all CF runtimes */
async function fetchWithTimeout(url, init = {}, ms = 9000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort("timeout"), ms);
  try {
    return await fetch(url, { ...init, signal: ac.signal });
  } finally {
    clearTimeout(t);
  }
}

/** One backend scan (sport="mlb"|"nfl"|...). send=true forces TG on backend side */
async function scanOnce(sport, { offset = 0, send = false } = {}, env) {
  const qs = new URLSearchParams({
    limit: "1",
    offset: String(offset),
    telegram: send ? "true" : "false",
    force: send ? "1" : "0",
  });
  const url = `${BACKEND}/api/scan/${sport}?${qs.toString()}`;
  const res = await fetchWithTimeout(url, {
    headers: {
      "X-Scan-Origin": "cf-cron",
      "X-Scan-Key": env.SCAN_KEY,       // must equal Render env SCAN_KEY
      "User-Agent": "cf-cron/1.0",
    },
  }, 9000);
  const txt = await res.text();
  return { ok: res.ok, status: res.status, body: safeJSON(txt) };
}

/* ------------------------------ HTTP fetch ----------------------------- */
async function fetchHandler(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;

  // credit-free connectivity probe to backend
  if (path === "/ping") {
    try {
      const r = await fetchWithTimeout(`${BACKEND}/health`, {}, 9000);
      const t = await r.text();
      return json({ ok: r.ok, status: r.status, body: safeJSON(t) });
    } catch (e) {
      return json({ ok: false, error: String(e) }, 599);
    }
  }

  if (path === "/run" || path === "/run-tg") {
    const send = (path === "/run-tg");
    const sports = (url.searchParams.get("sports") || "mlb")
      .split(",").map(s => s.trim()).filter(Boolean);
    const offset = Number(url.searchParams.get("offset") || "0") || 0;

    const results = {};
    for (const s of sports) {
      try {
        results[s] = await scanOnce(s, { offset, send }, env);
      } catch (e) {
        results[s] = { ok: false, error: String(e) };
      }
    }
    return json({ ok: true, origin: "cf-cron", send, results });
  }

  return json({ ok: true, name: "odds-scan-cron" });
}

/* ------------------------------ CRON entry ----------------------------- */
export async function scheduled(event, env, ctx) {
  if (!isETOpen()) { console.log("cron_skip_outside_ET_window"); return; }

  const sportsCsv = env.SCAN_SPORTS || "mlb";   // e.g., "mlb,nfl,ncaaf"
  const offset = Number(env.SCAN_OFFSET || "0") || 0;

  const sports = sportsCsv.split(",").map(s => s.trim()).filter(Boolean);
  for (const s of sports) {
    try {
      const r = await scanOnce(s, { offset, send: false }, env);
      console.log("cron_scan", s, r.status,
        typeof r.body === "object" ? (r.body.analyzed ?? r.body.pulled ?? 0) : 0);
    } catch (e) {
      console.log("cron_error", s, String(e));
    }
  }
}

/* --------------------------- default export ---------------------------- */
export default {
  fetch: fetchHandler,
  scheduled, // present on default for runtimes that expect it here
};
