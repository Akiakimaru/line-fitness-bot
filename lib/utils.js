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

/**
 * ジムログ用の日付換算（AM5時基準）
 * AM5:00〜翌日AM4:59までを同じ日として換算
 * 例：2025-10-09 03:00 → 2025-10-08
 *     2025-10-09 05:00 → 2025-10-09
 */
function convertToGymDate(dateTime) {
  const dt = new Date(dateTime);
  
  // JST時刻を取得
  const jstString = dt.toLocaleString("en-US", { timeZone: TZ });
  const jstDate = new Date(jstString);
  
  // 時刻が0:00〜4:59の場合は前日扱い
  const hour = jstDate.getHours();
  if (hour < 5) {
    jstDate.setDate(jstDate.getDate() - 1);
  }
  
  // YYYY-MM-DD形式で返す
  const y = jstDate.getFullYear();
  const m = String(jstDate.getMonth() + 1).padStart(2, "0");
  const d = String(jstDate.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * ジムログテキストを解析して構造化データを生成
 * 対応フォーマット:
 * - "ベンチプレス 20*12 50*10 50*10" → { name: "ベンチプレス", sets: [{w:20,r:12}, {w:50,r:10}, ...] }
 * - "ベンチプレス: 12回 x 50kg" → { name: "ベンチプレス", sets: [{w:50,r:12}] }
 * - "クロスバイク 30min 11km 210カロリー" → { name: "クロスバイク", minutes: 30, distance: 11, calories: 210 }
 * - "アシストチン(33kgアシスト) 5 5 5" → { name: "アシストチン", sets: [{w:33,r:5}, {w:33,r:5}, {w:33,r:5}], assist: true }
 */
function parseGymLogText(text) {
  if (!text || typeof text !== 'string') {
    return { exercises: [], totalSets: 0, totalMinutes: 0 };
  }

  const exercises = [];
  let totalSets = 0;
  let totalMinutes = 0;

  const lines = text.trim().split(/\n+/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // パターン1: "種目名 重量*回数 重量*回数 ..." (例: ベンチプレス 20*12 50*10)
    const pattern1 = /^(.+?)\s+((?:\d+\*\d+\s*)+)$/;
    const match1 = trimmed.match(pattern1);
    if (match1) {
      const exerciseName = match1[1].trim();
      const setsStr = match1[2].trim();
      const setMatches = setsStr.matchAll(/(\d+)\*(\d+)/g);
      const sets = [];
      for (const sm of setMatches) {
        sets.push({ weight: parseInt(sm[1]), reps: parseInt(sm[2]) });
      }
      exercises.push({ name: exerciseName, sets, type: 'strength' });
      totalSets += sets.length;
      continue;
    }

    // パターン2: "種目名(重量アシスト) 回数 回数 ..." (例: アシストチン(33kgアシスト) 5 5 5)
    const pattern2 = /^(.+?)\((\d+)kg[^)]*\)\s+((?:\d+\s*)+)$/;
    const match2 = trimmed.match(pattern2);
    if (match2) {
      const exerciseName = match2[1].trim();
      const weight = parseInt(match2[2]);
      const repsStr = match2[3].trim();
      const repsMatches = repsStr.matchAll(/(\d+)/g);
      const sets = [];
      for (const rm of repsMatches) {
        sets.push({ weight, reps: parseInt(rm[1]) });
      }
      exercises.push({ name: exerciseName, sets, type: 'strength', assist: true });
      totalSets += sets.length;
      continue;
    }

    // パターン3: "種目名: 回数 x 重量" (例: ベンチプレス: 12回 x 50kg)
    const pattern3 = /^(.+?)[:：]\s*(\d+)(?:回|rep)?\s*[x×]\s*(\d+)(?:kg)?/i;
    const match3 = trimmed.match(pattern3);
    if (match3) {
      const exerciseName = match3[1].trim();
      const reps = parseInt(match3[2]);
      const weight = parseInt(match3[3]);
      exercises.push({ name: exerciseName, sets: [{ weight, reps }], type: 'strength' });
      totalSets += 1;
      continue;
    }

    // パターン4: 有酸素運動 (例: クロスバイク 30min 11km 210カロリー)
    const pattern4 = /^(.+?)\s+(\d+)min\s+(?:(\d+(?:\.\d+)?)km)?\s*(?:(\d+)(?:カロリー|kcal)?)?/i;
    const match4 = trimmed.match(pattern4);
    if (match4) {
      const exerciseName = match4[1].trim();
      const minutes = parseInt(match4[2]);
      const distance = match4[3] ? parseFloat(match4[3]) : null;
      const calories = match4[4] ? parseInt(match4[4]) : null;
      exercises.push({ 
        name: exerciseName, 
        minutes, 
        distance, 
        calories, 
        type: 'cardio' 
      });
      totalMinutes += minutes;
      continue;
    }

    // パターン5: シンプルな種目名のみ（回数や重量なし）
    // 何も解析できない場合はスキップせず、種目名として記録
    if (trimmed.length > 0 && !/^\d+$/.test(trimmed)) {
      exercises.push({ name: trimmed, sets: [], type: 'other' });
    }
  }

  return { exercises, totalSets, totalMinutes };
}

module.exports = {
  TZ,
  DAYS,
  nowJST,
  parseYMDAsJST,
  getWeekAndDayJST,
  withBackoff,
  todayYMDJST,
  convertToGymDate,
  parseGymLogText,
};

// HMAC link signing functions moved to lib/auth.js for consistency
