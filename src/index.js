/* -------------------- Scan pacing & guards -------------------- */
// Env knobs (tune without redeploying)
const RATE_LIMIT_MS = Number(process.env.RATE_LIMIT_MS || 600);        // delay between *market* requests
const RETRY_429_MAX = Number(process.env.RETRY_429_MAX || 2);          // retries on 429 per market
const RETRY_BASE_MS = Number(process.env.RETRY_BASE_MS || 500);        // base backoff per retry
const CRON_PAUSE_BETWEEN_SPORTS_MS = Number(process.env.CRON_PAUSE_BETWEEN_SPORTS_MS || 1200);

// Mutexes so scans never overlap (per sport + global)
const sportLocks = new Map();  // sport -> boolean
let cronRunning = false;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function withSportLock(sport, fn) {
  if (sportLocks.get(sport)) {
    console.warn(`🔒 Skip scan for ${sport} (already running)`);
    return null;
  }
  sportLocks.set(sport, true);
  try { return await fn(); }
  finally { sportLocks.set(sport, false); }
}

/* -------------------- Backoff + paced fetch -------------------- */
async function fetchWithRetry(label, fn, args = {}) {
  let attempt = 0;
  const jitter = () => Math.floor(Math.random() * 120);

  while (true) {
    try {
      const out = await fn(args);
      return Array.isArray(out) ? out : [];
    } catch (err) {
      const msg = String(err?.message || err);

      // Unsupported → skip quietly
      if (msg.includes("INVALID_MARKET") || msg.includes("Markets not supported") || msg.includes("status=422")) {
        console.warn(`⚠️  Skipping unsupported market: ${label}`);
        return [];
      }

      // 429 throttle → backoff + retry a couple times
      if (msg.includes("429") || msg.toLowerCase().includes("too many requests")) {
        if (attempt >= RETRY_429_MAX) {
          console.warn(`⏳ 429 on ${label} — max retries hit, skipping`);
          return [];
        }
        const wait = RETRY_BASE_MS * Math.pow(2, attempt) + jitter();
        console.warn(`⏳ 429 on ${label} — retry in ${wait}ms (attempt ${attempt + 1}/${RETRY_429_MAX})`);
        await sleep(wait);
        attempt++;
        continue;
      }

      console.error(`❌ Fetch failed for ${label}:`, err);
      return [];
    }
  }
}

/** Run market jobs sequentially with pacing to avoid bursts. */
async function runSequential(jobs /* [label, fn, args][] */) {
  const out = [];
  for (const [label, fn, args] of jobs) {
    const data = await fetchWithRetry(label, fn, args);
    out.push(data);
    await sleep(RATE_LIMIT_MS);
  }
  return out.flat();
}
