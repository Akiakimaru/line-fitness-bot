// services/lineHandlers.js
const line = require("@line/bot-sdk");
const { getWeekAndDayJST, todayYMDJST, nowJST } = require("../lib/utils");
const { loadMealPlan } = require("../lib/sheets");
const { registerUser, appendLogRecord } = require("../lib/sheets");

// 既存のクライアントは index.js 側から渡される想定
// ここでは handleEvent / getTodayMenuText をエクスポート

/* ================= ユーティリティ ================= */

function normalizeTimeToken(t) {
  // "9:5" → "09:05"
  const m = String(t || "").match(/^(\d{1,2}):(\d{1,2})$/);
  if (!m) return null;
  const hh = String(parseInt(m[1], 10)).padStart(2, "0");
  const mm = String(parseInt(m[2], 10)).padStart(2, "0");
  if (parseInt(hh, 10) > 23 || parseInt(mm, 10) > 59) return null;
  return `${hh}:${mm}`;
}

/** 1行目に時刻があれば取り出す。例:
 *  "食事 12:30\n鶏むね、ヨーグルト"
 *  "ジム 7:05\nベンチ…"
 *  戻り値: { time: "HH:MM" | null, body: "…本文…" }
 */
function extractTimeAndBody(raw) {
  const lines = (raw || "").split(/\r?\n/);
  let header = lines[0].trim();
  let body = lines.slice(1).join("\n").trim();

  // パターンA: "<cmd> HH:MM"
  const mA = header.match(/\b(\d{1,2}:\d{1,2})\b/);
  if (mA) {
    const t = normalizeTimeToken(mA[1]);
    if (t) return { time: t, body };
  }
  // パターンB: 本文先頭に HH:MM があるなら時刻として採用
  const mB = body.match(/^\s*(\d{1,2}:\d{1,2})\s*[\n ]/);
  if (mB) {
    const t = normalizeTimeToken(mB[1]);
    if (t) {
      body = body.replace(mB[0], "").trim();
      return { time: t, body };
    }
  }
  return { time: null, body: (raw || "").split(/\r?\n/).slice(1).join("\n").trim() };
}

/* ==== ジム入力の簡易パーサ =======================================
 * 入力例:
 *   ベンチプレス 50*10 60*8
 *   サイドレイズ 3x15
 *   トレッドミル 8分2.8km
 * 複数行OK。行ごとに1種目。
 * 返却: [{name, sets:[{w,reps}], minutes, distanceKm, raw}]
 * ================================================================= */
function parseGymText(text) {
  const lines = (text || "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const out = [];

  for (const line of lines) {
    const nameMatch = line.match(/^[^\d]+/); // 先頭の非数字を種目名とみなす
    const name = nameMatch ? nameMatch[0].trim() : "不明種目";
    const rest = line.slice(name.length).trim();

    // パターン: 50*10 60*8 / 3x15 など
    const tokens = rest.split(/[,\s]+/).filter(Boolean);
    const sets = [];
    let minutes = null;
    let distanceKm = null;

    for (const tk of tokens) {
      // 8分 / 10分
      const mMin = tk.match(/^(\d+)\s*分$/);
      if (mMin) {
        minutes = parseInt(mMin[1], 10);
        continue;
      }
      // 2.8km
      const mKm = tk.match(/^(\d+(?:\.\d+)?)\s*km$/i);
      if (mKm) {
        distanceKm = parseFloat(mKm[1]);
        continue;
      }
      // 50*10 or 50x10
      const mWR = tk.match(/^(\d+(?:\.\d+)?)[x\*](\d+)$/i);
      if (mWR) {
        sets.push({ w: parseFloat(mWR[1]), reps: parseInt(mWR[2], 10) });
        continue;
      }
      // 3x15 のような「セットx回数」（重量なし）
      const mSR = tk.match(/^(\d+)[x\*](\d+)$/i);
      if (mSR) {
        sets.push({ w: null, reps: parseInt(mSR[2], 10), sets: parseInt(mSR[1], 10) });
        continue;
      }
    }
    out.push({ name, sets, minutes, distanceKm, raw: line });
  }
  return out;
}

/* ================= 今日のメニュー（既存） ================= */
async function getTodayMenuText() {
  const { week, day } = getWeekAndDayJST(process.env.START_DATE);
  const { rows, idx } = await loadMealPlan();

  const today = rows.filter(
    (r) =>
      String(r._rawData[idx.Week]).trim() === String(week) &&
      String(r._rawData[idx.Day]).trim().toLowerCase() === day.toLowerCase()
  );
  if (!today.length) return `今日のメニューは未設定です。\n（Week${week} ${day})`;

  const meals = today.filter((r) => String(r._rawData[idx.Kind]).trim() === "Meal");
  const trainings = today.filter((r) => String(r._rawData[idx.Kind]).trim() === "Training");

  let text = `【今日のメニュー】(Week${week} ${day})\n\n🍽 食事\n`;
  for (const r of meals) {
    const slot = String(r._rawData[idx.Slot]).trim();
    const desc = String(r._rawData[idx.Text]).trim();
    const kcal = String(r._rawData[idx.Calories]).trim();
    const P = String(r._rawData[idx.P]).trim();
    const F = String(r._rawData[idx.F]).trim();
    const C = String(r._rawData[idx.C]).trim();
    const tips = String(r._rawData[idx.Tips] || "-").trim();
    text += `- ${slot}: ${desc} （${kcal}kcal, P${P} F${F} C${C}）\n  👉 ${tips}\n`;
  }
  if (trainings.length) {
    text += `\n💪 トレーニング\n`;
    for (const r of trainings) {
      const slot = String(r._rawData[idx.Slot]).trim();
      const desc = String(r._rawData[idx.Text]).trim();
      const tips = String(r._rawData[idx.Tips] || "-").trim();
      text += `- ${slot}: ${desc}\n  👉 ${tips}\n`;
    }
  }
  return text;
}

/* ================= ログ入力: 食事/ジム ================= */

const PENDING = new Map(); // userId -> {mode: 'meal'|'gym', timeHHMM|null}

function startMealPending(userId, headerText) {
  const { time } = extractTimeAndBody(headerText);
  PENDING.set(userId, { mode: "meal", timeHHMM: time });
}
function startGymPending(userId, headerText) {
  const { time } = extractTimeAndBody(headerText);
  PENDING.set(userId, { mode: "gym", timeHHMM: time });
}

async function handlePendingInput(userId, text, client, replyToken) {
  const st = PENDING.get(userId);
  if (!st) return false;

  const jstNow = nowJST();
  let ts = jstNow;
  if (st.timeHHMM) {
    const [hh, mm] = st.timeHHMM.split(":").map((n) => parseInt(n, 10));
    ts = new Date(jstNow);
    ts.setHours(hh, mm, 0, 0);
  }

  if (st.mode === "meal") {
    // そのままテキストを保存
    const rec = {
      DateTime: ts.toISOString(),
      UserId: userId,
      Kind: "Meal",
      Text: text.trim(),
      MetaJSON: JSON.stringify({ time: st.timeHHMM || null }),
    };
    await appendLogRecord(rec);
    await client.replyMessage(replyToken, {
      type: "text",
      text: `🍽 食事ログを保存しました\n${st.timeHHMM ? `時刻 ${st.timeHHMM}\n` : ""}${text.trim()}`,
    });
    PENDING.delete(userId);
    return true;
  }

  if (st.mode === "gym") {
    const parsed = parseGymText(text);
    const rec = {
      DateTime: ts.toISOString(),
      UserId: userId,
      Kind: "Gym",
      Text: text.trim(),
      MetaJSON: JSON.stringify({ time: st.timeHHMM || null, parsed }),
    };
    await appendLogRecord(rec);
    await client.replyMessage(replyToken, {
      type: "text",
      text: `💪 ジムログを保存しました\n${st.timeHHMM ? `時刻 ${st.timeHHMM}\n` : ""}${text.trim()}`,
    });
    PENDING.delete(userId);
    return true;
  }
  return false;
}

/* ================= LINEイベント ================= */

async function handleEvent(e, client) {
  if (e?.source?.userId) {
    // Users に登録/更新
    await registerUser(e.source.userId);
  }
  if (e.type !== "message" || e.message?.type !== "text") return;

  const msg = (e.message.text || "").trim();

  // 1) まず pending 中なら本文として処理
  if (await handlePendingInput(e.source.userId, msg, client, e.replyToken)) return;

  // 2) 新形式：コマンド開始「食事」「ジム」
  if (msg === "食事" || msg.startsWith("食事 ")) {
    startMealPending(e.source.userId, msg);
    return client.replyMessage(e.replyToken, {
      type: "text",
      text: "食事内容を入力してください（例: 鶏むね肉、ヨーグルト）。\n1行目に時刻を含めたい場合は「食事 12:30」と送ってから本文を入力してください。",
    });
  }
  if (msg === "ジム" || msg.startsWith("ジム ")) {
    startGymPending(e.source.userId, msg);
    return client.replyMessage(e.replyToken, {
      type: "text",
      text: "ジム記録を入力してください（複数行可）。\n例:\nベンチプレス 50*10 60*8\nトレッドミル 8分2.8km\n※ 1行目に時刻を含めたい場合は「ジム 07:10」と送ってから本文を入力。",
    });
  }

  // 3) 既存コマンド
  if (msg.includes("今日のメニュー")) {
    const menu = await getTodayMenuText();
    return client.replyMessage(e.replyToken, { type: "text", text: menu });
  }

  // 4) 既存の編集フローや管理コマンドは省略（必要なら以前の実装のまま）
  return client.replyMessage(e.replyToken, {
    type: "text",
    text:
      "コマンドを選んでください。",
    quickReply: {
      items: [
        { type: "action", action: { type: "message", label: "今日のメニュー", text: "今日のメニュー" } },
        { type: "action", action: { type: "message", label: "食事ログ", text: "食事" } },
        { type: "action", action: { type: "message", label: "ジムログ", text: "ジム" } },
      ],
    },
  });
}

module.exports = {
  handleEvent,
  getTodayMenuText,
};
