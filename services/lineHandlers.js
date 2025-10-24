// services/lineHandlers.js
const { getWeekAndDayJST, todayYMDJST, nowJST, signUserLink } = require("../lib/utils");
const { loadMealPlan, registerUser, appendLogRecord } = require("../lib/sheets");

/* ================= ユーティリティ ================= */

function normalizeTimeToken(t) {
  const m = String(t || "").match(/^(\d{1,2}):(\d{1,2})$/);
  if (!m) return null;
  const hh = String(parseInt(m[1], 10)).padStart(2, "0");
  const mm = String(parseInt(m[2], 10)).padStart(2, "0");
  if (parseInt(hh, 10) > 23 || parseInt(mm, 10) > 59) return null;
  return `${hh}:${mm}`;
}

/** 1行目/本文先頭に時刻(HH:MM)があれば取り出す */
function extractTimeAndBody(raw) {
  if (!raw) return { time: null, body: "" };
  const lines = raw.split(/\r?\n/);
  let header = (lines[0] || "").trim();
  let body = lines.slice(1).join("\n").trim();

  // パターンA: 1行目末尾に HH:MM
  const mA = header.match(/\b(\d{1,2}:\d{1,2})\b/);
  if (mA) {
    const t = normalizeTimeToken(mA[1]);
    if (t) return { time: t, body };
  }
  // パターンB: 本文先頭が HH:MM
  const mB = body.match(/^\s*(\d{1,2}:\d{1,2})\s*[\n ]/);
  if (mB) {
    const t = normalizeTimeToken(mB[1]);
    if (t) {
      body = body.replace(mB[0], "").trim();
      return { time: t, body };
    }
  }
  return { time: null, body };
}

/** 先頭コマンドと本文を抽出
 *  入力例:
 *   - "食事\nヨーグルト"
 *   - "食事 12:30\n鶏むね"
 *   - "食事 ヨーグルト"
 *   - "ジム\nベンチ 50*10"
 *   - "体重 79.2"
 */
function parseCommandAndBody(msg) {
  const lines = msg.split(/\r?\n/);
  const head = lines[0].trim();
  const bodyLines = lines.slice(1);
  // 先頭ワード（食事/ジム/体重）と残り
  const m = head.match(/^(食事|ジム|体重)(?:\s+(.*))?$/);
  if (!m) return null;
  const cmd = m[1];
  const tail = (m[2] || "").trim(); // 同一行の追加情報（時刻や数値、本文の一部）

  // 本文の合成（同一行の tail が本文か/時刻かは後段で判定）
  let body = bodyLines.join("\n").trim();
  if (!body && tail) {
    body = tail; // 1行式（例: "食事 ヨーグルト" / "体重 79.2"）
  }
  return { cmd, headTail: tail, body };
}

/* ==== ジム入力の簡易パーサ（メタ情報用） ========================= */
function parseGymText(text) {
  const lines = (text || "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const out = [];

  for (const line of lines) {
    const nameMatch = line.match(/^[^\d]+/);
    const name = nameMatch ? nameMatch[0].trim() : "不明種目";
    const rest = line.slice(name.length).trim();

    const tokens = rest.split(/[,\s]+/).filter(Boolean);
    const sets = [];
    let minutes = null;
    let distanceKm = null;

    for (const tk of tokens) {
      const mMin = tk.match(/^(\d+)\s*分$/);
      if (mMin) {
        minutes = parseInt(mMin[1], 10);
        continue;
      }
      const mKm = tk.match(/^(\d+(?:\.\d+)?)\s*km$/i);
      if (mKm) {
        distanceKm = parseFloat(mKm[1]);
        continue;
      }
      const mWR = tk.match(/^(\d+(?:\.\d+)?)[x\*](\d+)$/i);
      if (mWR) {
        sets.push({ w: parseFloat(mWR[1]), reps: parseInt(mWR[2], 10) });
        continue;
      }
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

/* ================= ログ入力：ワンショット & 2段階両対応 ================= */

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

/* ================= LINEイベント（メイン） ================= */

async function handleEvent(e, client) {
  if (e?.source?.userId) {
    await registerUser(e.source.userId);
  }
  if (e.type !== "message" || e.message?.type !== "text") return;

  const msg = (e.message.text || "").trim();

  // 0) ワンショット（1メッセージ完結）を最優先で処理
  const parsed = parseCommandAndBody(msg);
  if (parsed) {
    const { cmd, headTail, body } = parsed;

    // 体重ワンショット（例: "体重 79.2" / "体重\n79.2"）
    if (cmd === "体重") {
      const val = parseFloat(body || headTail);
      if (!isNaN(val)) {
        const rec = {
          DateTime: nowJST().toISOString(),
          UserId: e.source.userId,
          Kind: "Weight",
          Text: String(val),
          MetaJSON: JSON.stringify({ unit: "kg" }),
        };
        await appendLogRecord(rec);
        return client.replyMessage(e.replyToken, {
          type: "text",
          text: `⚖️ 体重を記録しました：${val}kg`,
        });
      }
      // 本文が空なら2段階フローにフォールバック
      if (!body && !headTail) {
        // continue to pending handler below
      } else {
        return client.replyMessage(e.replyToken, {
          type: "text",
          text: "体重を数値で入力してください（例: 体重 79.2）",
        });
      }
    }

    // 食事ワンショット（例: "食事\nヨーグルト" / "食事 ヨーグルト" / "食事 12:30\n鶏むね"）
    if (cmd === "食事" && body) {
      const { time, body: mealBody } = extractTimeAndBody(`${cmd} ${headTail}\n${body}`.trim());
      const jstNow = nowJST();
      let ts = jstNow;
      if (time) {
        const [hh, mm] = time.split(":").map((n) => parseInt(n, 10));
        ts = new Date(jstNow);
        ts.setHours(hh, mm, 0, 0);
      }
      const rec = {
        DateTime: ts.toISOString(),
        UserId: e.source.userId,
        Kind: "Meal",
        Text: mealBody.trim(),
        MetaJSON: JSON.stringify({ time: time || null }),
      };
      await appendLogRecord(rec);
      return client.replyMessage(e.replyToken, {
        type: "text",
        text: `🍽 食事ログを保存しました\n${time ? `時刻 ${time}\n` : ""}${mealBody.trim()}`,
      });
    }

    // ジムワンショット（例: "ジム\nベンチ 50*10" / "ジム 07:05\nバイク 15分"）
    if (cmd === "ジム" && body) {
      const { time, body: gymBody } = extractTimeAndBody(`${cmd} ${headTail}\n${body}`.trim());
      const jstNow = nowJST();
      let ts = jstNow;
      if (time) {
        const [hh, mm] = time.split(":").map((n) => parseInt(n, 10));
        ts = new Date(jstNow);
        ts.setHours(hh, mm, 0, 0);
      }
      const parsedGym = parseGymText(gymBody);
      const rec = {
        DateTime: ts.toISOString(),
        UserId: e.source.userId,
        Kind: "Gym",
        Text: gymBody.trim(),
        MetaJSON: JSON.stringify({ time: time || null, parsed: parsedGym }),
      };
      await appendLogRecord(rec);
      return client.replyMessage(e.replyToken, {
        type: "text",
        text: `💪 ジムログを保存しました\n${time ? `時刻 ${time}\n` : ""}${gymBody.trim()}`,
      });
    }

    // ここまで来たら本文が無いケース（→2段階フロー開始へ）
    if (cmd === "食事") {
      startMealPending(e.source.userId, msg);
      return client.replyMessage(e.replyToken, {
        type: "text",
        text: "食事内容を入力してください（例: 鶏むね肉、ヨーグルト）。\n1行目に時刻を含めたい場合は「食事 12:30」と送ってから本文を入力してください。",
      });
    }
    if (cmd === "ジム") {
      startGymPending(e.source.userId, msg);
      return client.replyMessage(e.replyToken, {
        type: "text",
        text: "ジム記録を入力してください（複数行可）。\n例:\nベンチプレス 50*10 60*8\nトレッドミル 8分2.8km\n※ 1行目に時刻を含めたい場合は「ジム 07:10」と送ってから本文を入力。",
      });
    }
    if (cmd === "体重") {
      return client.replyMessage(e.replyToken, {
        type: "text",
        text: "体重を入力してください（例: 体重 79.2）",
      });
    }
  }

  // 1) pending中なら本文として処理
  if (await handlePendingInput(e.source.userId, msg, client, e.replyToken)) return;

  // 2) 既存コマンド
  if (msg.includes("今日のメニュー")) {
    const menu = await getTodayMenuText();
    return client.replyMessage(e.replyToken, { type: "text", text: menu });
  }

  // 2.5) マイページリンク
  if (msg.includes("マイページ")) {
    const { uid, exp, sig } = signUserLink(e.source.userId, 60 * 60 * 24 * 7);
    const base = process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || "";
    const url = `${base.replace(/\/$/, "")}/mypage?uid=${encodeURIComponent(uid)}&exp=${encodeURIComponent(exp)}&sig=${encodeURIComponent(sig)}`;
    return client.replyMessage(e.replyToken, {
      type: "text",
      text: `マイページはこちらから\n${url}`,
    });
  }

  // 2.6) HIITプラン
  if (msg.includes("HIIT") || msg.includes("hiit") || msg.includes("ヒット")) {
    const base = process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || "";
    const url = `${base.replace(/\/$/, "")}/hiit-plan.html`;
    return client.replyMessage(e.replyToken, {
      type: "text",
      text: `🚴‍♂️ Cycling HIIT 20分プラン\n${url}\n\n高強度インターバルトレーニングの詳細プランです。負荷8/16/20、心拍数165-175bpmを目標に7セット行います。`,
    });
  }

  // 3) デフォルト応答（入口を明示）
  return client.replyMessage(e.replyToken, {
    type: "text",
    text:
      "コマンドを選んでください。",
    quickReply: {
      items: [
        { type: "action", action: { type: "message", label: "今日のメニュー", text: "今日のメニュー" } },
        { type: "action", action: { type: "message", label: "食事ログ", text: "食事" } },
        { type: "action", action: { type: "message", label: "ジムログ", text: "ジム" } },
        { type: "action", action: { type: "message", label: "体重ログ", text: "体重" } },
        { type: "action", action: { type: "message", label: "マイページ", text: "マイページ" } },
        { type: "action", action: { type: "message", label: "HIITプラン", text: "HIIT" } },
      ],
    },
  });
}

module.exports = {
  handleEvent,
  getTodayMenuText,
};
