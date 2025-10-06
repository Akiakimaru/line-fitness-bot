// lib/utils.js
const TZ = "Asia/Tokyo";
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withBackoff(op, { tries = 5, baseMs = 400 } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      return await op();
    } catch (e) {
      lastErr = e;
      const status = e?.response?.status || e?.code || "";
      const msg = String(e || "");
      const retryable =
        [429, 500, 502, 503, 504].includes(status) ||
        /rate|quota|temporar|EAI_AGAIN|socket hang up/i.test(msg);
      if (!retryable) throw e;
      const wait = baseMs * Math.pow(2, i) + Math.floor(Math.random() * 150);
      console.warn(`[backoff] attempt=${i + 1}/${tries} wait=${wait}ms reason=${status || msg}`);
      await sleep(wait);
    }
  }
  throw lastErr;
}

function nowJST() {
  return new Date(Date.now() + 9 * 60 * 60 * 1000);
}
function todayYMDJST() {
  return nowJST().toISOString().slice(0, 10);
}
function parseYMDAsJST(ymd) {
  return new Date(`${ymd}T00:00:00+09:00`);
}
function getWeekAndDayJST(startDateYMD) {
  const start = parseYMDAsJST(startDateYMD);
  const now = nowJST();
  const diffDays = Math.floor((now - start) / (1000 * 60 * 60 * 24));
  const week = Math.max(1, Math.floor(diffDays / 7) + 1);
  const day = DAYS[now.getUTCDay()]; // JST化Dateに対しUTC曜日でOK
  return { week, day, jstISO: now.toISOString() };
}

module.exports = {
  TZ,
  DAYS,
  sleep,
  withBackoff,
  nowJST,
  todayYMDJST,
  parseYMDAsJST,
  getWeekAndDayJST
};
