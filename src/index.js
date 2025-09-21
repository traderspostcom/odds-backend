// index.js
import express from "express";
import { google } from "googleapis";
import { fetchOddsAndNormalize } from "./odds_service.js";  
import { ipFromAmerican, evAmerican } from "./odds_math.js";

const app = express();
app.use(express.json({ limit: "5mb" }));

const PORT = process.env.PORT || 3000;
const SHARED_TOKEN = process.env.SHARED_TOKEN;
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const GOOGLE_CLIENT_EMAIL = process.env.GOOGLE_CLIENT_EMAIL;
const GOOGLE_PRIVATE_KEY = (process.env.GOOGLE_PRIVATE_KEY || "").replace(/\\n/g, "\n");

if (!SHARED_TOKEN || !SPREADSHEET_ID || !GOOGLE_CLIENT_EMAIL || !GOOGLE_PRIVATE_KEY) {
  console.error("❌ Missing env vars.");
  process.exit(1);
}

// Google Sheets auth
const auth = new google.auth.JWT(
  GOOGLE_CLIENT_EMAIL,
  null,
  GOOGLE_PRIVATE_KEY,
  ["https://www.googleapis.com/auth/spreadsheets"]
);
const sheets = google.sheets({ version: "v4", auth });

// --- Helpers ---
function fromAmerican(am) {
  const n = Number(am);
  if (!Number.isFinite(n) || n === 0) return { decimal: null, implied: null };
  const dec = n > 0 ? (1 + n / 100) : (1 + 100 / Math.abs(n));
  const imp = n > 0 ? (100 / (n + 100)) : (Math.abs(n) / (Math.abs(n) + 100));
  return { decimal: dec, implied: imp };
}

function parseFairProb(row) {
  const fairPctRaw = row["Fair %"] ?? row["Fair%"] ?? row["FairPct"];
  if (fairPctRaw !== undefined && String(fairPctRaw).trim() !== "") {
    const num = Number(String(fairPctRaw).replace("%", "").trim());
    if (Number.isFinite(num)) return Math.min(Math.max(num / 100, 0), 1);
  }
  const fairLineRaw = row["Fair Line"] ?? row["Fair (Am)"] ?? row["Fair Odds"];
  if (fairLineRaw !== undefined && String(fairLineRaw).trim() !== "") {
    const { implied } = fromAmerican(fairLineRaw);
    if (implied !== null) return Math.min(Math.max(implied, 0), 1);
  }
  return null;
}

function nowET() {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date()).map(p => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

async function ensureSheetAndHeaders(spreadsheetId, sheetName, requiredHeaders) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const found = meta.data.sheets?.find(s => s.properties.title === sheetName);
  if (!found) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: sheetName } } }] },
    });
  }
  const res = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${sheetName}!1:1` }).catch(() => null);
  let headers = res?.data?.values?.[0]?.map(String) || [];
  if (headers.length === 0) {
    headers = requiredHeaders.slice();
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${sheetName}!1:1`,
      valueInputOption: "RAW",
      requestBody: { values: [headers] },
    });
  } else {
    const missing = requiredHeaders.filter(h => !headers.includes(h));
    if (missing.length) {
      headers = headers.concat(missing);
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `${sheetName}!1:1`,
        valueInputOption: "RAW",
        requestBody: { values: [headers] },
      });
    }
  }
  return headers;
}

// --- Routes ---

/** Root check */
app.get("/", (req, res) => res.json({ ok: true, service: "bets-to-sheets" }));

/** ✅ Odds lookup route */
app.get("/odds", async (req, res) => {
  try {
    const { sportKey, market, team, side, spreadPoint, totalPoint, books, line } = req.query;
    if (!sportKey) {
      return res.status(400).json({ ok: false, error: "sportKey is required" });
    }
    const oddsInfo = await fetchOddsAndNormalize({
      sportKey,
      market,
      team,
      side,
      spreadPoint: spreadPoint ? Number(spreadPoint) : null,
      totalPoint: totalPoint ? Number(totalPoint) : null,
      books: books ? books.split(",").map(s => s.trim()) : [],
      line
    });
    return res.json({ ok: true, result: oddsInfo });
  } catch (err) {
    console.error("Odds endpoint failed:", err);
    return res.status(500).json({ ok: false, error: err.message || String(err) });
  }
});

/** ✅ Ingest route (Google Sheets logging) */
app.post("/ingest", async (req, res) => {
  try {
    const token = req.get("X-Auth");
    if (token !== SHARED_TOKEN) return res.status(401).json({ ok: false, error: "Unauthorized" });

    const { mode, rows } = req.body || {};
    if (!["track", "buy"].includes(mode)) return res.status(400).json({ ok: false, error: "mode must be 'track' or 'buy'" });
    if (!Array.isArray(rows) || rows.length === 0) return res.status(400).json({ ok: false, error: "rows[] required" });

    const schema = {
      track: [
        "Date (ET)", "Sport", "Market", "Side", "Book", "Odds (Am)", "Decimal", "Implied %", "Fair %", "Model %",
        "Blend %", "Edge %", "EV per $1", "Kelly %", "Kelly (25%)", "Confidence", "Rationale", "Entry Timing", "Risk Flags",
        "Play-to (Am)", "Fetched (ET)", "CLV %", "Result"
      ],
      buy: ["Date", "bankroll", "Pick", "Line", "Bet Amount"]
    }[mode];

    const sheetName = mode === "track" ? "Track" : "Buy";
    const headers = await ensureSheetAndHeaders(SPREADSHEET_ID, sheetName, schema);

    const outRows = [];
    for (const r of rows) {
      let newRow = { ...r };

      const provided = newRow["Odds (Am)"] ?? newRow.Line;
      if (provided) {
        const { decimal, implied } = fromAmerican(provided);
        if (decimal) newRow["Decimal"] = Number(decimal.toFixed(4));
        if (implied) newRow["Implied %"] = Number((implied * 100).toFixed(2)) + "%";
      }

      const pFair = parseFairProb(newRow);
      const dInfo = fromAmerican(provided);
      const d = dInfo.decimal;
      const pImp = dInfo.implied;

      if (pFair !== null && d !== null && pImp !== null) {
        const edgePct = (pFair - pImp) * 100;
        const evPer1 = pFair * (d - 1) - (1 - pFair);
        let kelly = ((d * pFair) - (1 - pFair)) / (d - 1);
        if (!Number.isFinite(kelly) || kelly < 0) kelly = 0;
        if (kelly > 1) kelly = 1;

        newRow["Edge %"] = Number(edgePct.toFixed(2)) + "%";
        newRow["EV per $1"] = Number(evPer1.toFixed(3));
        newRow["Kelly %"] = Number((kelly * 100).toFixed(2)) + "%";
        newRow["Kelly (25%)"] = Number((kelly * 25).toFixed(2)) + "%";
      }

      newRow["Fetched (ET)"] = nowET();
      outRows.push(newRow);
    }

    const rowValues = outRows.map(r => headers.map(h => r[h] ?? ""));
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: `${sheetName}!A:A`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: rowValues },
    });

    res.json({ ok: true, sheetName, inserted: rowValues.length });
  } catch (e) {
    console.error("Ingest failed:", e);
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});

