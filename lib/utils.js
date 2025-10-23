// lib/utils.js
const TZ = "Asia/Tokyo";
const crypto = require("crypto");
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** JSTの「今」を安全に取得 */
function nowJST() {
  // toLocaleStringでTZ変換 → new Dateでローカル→UTCへ変換
  const s = new Date().toLocaleString("en-US", { timeZone: TZ });
  return new Date(s);
}

/** YYYY-MM-DD を JST 0:00 として解釈（不正なら今日） */
function parseYMDAsJST(ymd) {
  if (!ymd || !/^\d{4}-\d{2}-\d{2}$/.test(ymd)) {
    console.error("[parseYMDAsJST] Invalid START_DATE:", ymd);
    const d = nowJST();
    d.setHours(0, 0, 0, 0);
    return d;
  }
  // ymd は JSTの0:00 として扱う
  const [y, m, d] = ymd.split("-").map(Number);
  const j = new Date(Date.UTC(y, m - 1, d, 0, 0, 0));
  // UTC→JST(+9h) 実体へのズレは nowJST と同様の方式で不要。ここは「基準日付」として 0:00 扱いでOK
  return j;
}

/** 開始日からの経過で Week/Day を計算（JST） */
function getWeekAndDayJST(startDateEnv = process.env.START_DATE) {
  const start = parseYMDAsJST(startDateEnv);
  const now = nowJST();

  // JST 日付の 0:00 を基準化
  const startJ = new Date(start);
  startJ.setHours(0, 0, 0, 0);

  const todayJ = new Date(now);
  todayJ.setHours(0, 0, 0, 0);

  const diffDays = Math.floor((todayJ - startJ) / (1000 * 60 * 60 * 24));
  const week = Math.max(1, Math.floor(diffDays / 7) + 1);

  // JSTの曜日
  const dayIndex = todayJ.getDay(); // 0=Sun
  const day = DAYS[dayIndex];

  return { week, day, jstISO: now.toISOString() };
}

/** 共通バックオフ */
async function withBackoff(fn, tries = 5, baseMs = 300, factor = 2) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const ms = baseMs * Math.pow(factor, i);
      await new Promise((r) => setTimeout(r, ms));
    }
  }
  throw lastErr;
}

/** 今日を YYYY-MM-DD（JST）で返す */
function todayYMDJST() {
  const d = nowJST();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

module.exports = {
  TZ,
  DAYS,
  nowJST,
  parseYMDAsJST,
  getWeekAndDayJST,
  withBackoff,
  todayYMDJST,
};

/* ================= HMAC link signing for user MyPage ================= */
/** Create short-lived signature for a user link */
function signUserLink(userId, ttlSec = 60 * 60 * 24) {
  const secret = process.env.MYPAGE_SECRET || "dev-secret";
  const exp = Math.floor(Date.now() / 1000) + Math.max(60, ttlSec);
  const payload = `${userId}.${exp}`;
  const sig = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  return { uid: userId, exp, sig };
}

/** Verify signature and expiration */
function verifyUserLink(uid, exp, sig) {
  const secret = process.env.MYPAGE_SECRET || "dev-secret";
  const now = Math.floor(Date.now() / 1000);
  if (!uid || !exp || !sig) return false;
  if (Number(exp) < now) return false;
  const payload = `${uid}.${exp}`;
  const expect = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  // constant-time compare
  try {
    return crypto.timingSafeEqual(Buffer.from(expect), Buffer.from(String(sig)));
  } catch (_) {
    return false;
  }
}

module.exports.signUserLink = signUserLink;
module.exports.verifyUserLink = verifyUserLink;
