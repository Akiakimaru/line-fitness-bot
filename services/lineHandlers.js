// services/lineHandlers.js
const { todayYMDJST, getWeekAndDayJST } = require("../lib/utils");
const { loadMealPlan, appendLogs } = require("../lib/sheets");

const ADMIN_KEY = process.env.ADMIN_KEY || "";
let LAST_USER_ID = null;     // 単独運用想定
let editContext = null;      // { slot, draft? }

const cell = (row, i) => String((row._rawData && row._rawData[i]) ?? "").trim();

async function getTodayMenuText() {
  const { week, day } = getWeekAndDayJST(process.env.START_DATE);
  const { rows, idx } = await loadMealPlan();
  const today = rows.filter(
    (r) =>
      cell(r, idx.Week) === String(week) &&
      cell(r, idx.Day).toLowerCase() === day.toLowerCase()
  );
  if (!today.length) return `今日のメニューは未設定です。\n（Week${week} ${day})`;

  const meals = today.filter((r) => cell(r, idx.Kind) === "Meal");
  const trainings = today.filter((r) => cell(r, idx.Kind) === "Training");

  let text = `【今日のメニュー】(Week${week} ${day})\n\n🍽 食事\n`;
  for (const r of meals) {
    const slot = cell(r, idx.Slot);
    const desc = cell(r, idx.Text);
    const kcal = cell(r, idx.Calories);
    const P = cell(r, idx.P);
    const F = cell(r, idx.F);
    const C = cell(r, idx.C);
    const tips = cell(r, idx.Tips) || "-";
    text += `- ${slot}: ${desc} （${kcal}kcal, P${P} F${F} C${C}）\n  👉 ${tips}\n`;
  }
  if (trainings.length) {
    text += `\n💪 トレーニング\n`;
    for (const r of trainings) {
      const slot = cell(r, idx.Slot);
      const desc = cell(r, idx.Text);
      const tips = cell(r, idx.Tips) || "-";
      text += `- ${slot}: ${desc}\n  👉 ${tips}\n`;
    }
  }
  return text;
}

async function getTodaySlotText(slotLabel) {
  const { week, day } = getWeekAndDayJST(process.env.START_DATE);
  const { rows, idx } = await loadMealPlan();
  const r = rows.find(
    (r) =>
      cell(r, idx.Week) === String(week) &&
      cell(r, idx.Day).toLowerCase() === day.toLowerCase() &&
      cell(r, idx.Slot) === slotLabel &&
      ["Meal", "Training"].includes(cell(r, idx.Kind))
  );
  if (!r) return null;

  if (cell(r, idx.Kind) === "Meal") {
    const kcal = cell(r, idx.Calories);
    const P = cell(r, idx.P);
    const F = cell(r, idx.F);
    const C = cell(r, idx.C);
    const tips = cell(r, idx.Tips) || "-";
    return `【${slotLabel}】${cell(r, idx.Text)}（${kcal}kcal, P${P} F${F} C${C}）\n👉 ${tips}`;
  } else {
    const tips = cell(r, idx.Tips) || "-";
    return `【${slotLabel}】${cell(r, idx.Text)}\n👉 ${tips}`;
  }
}

async function handleEvent(e, lineClient) {
  if (e?.source?.userId) LAST_USER_ID = e.source.userId;
  if (e.type !== "message" || e.message?.type !== "text") return;

  const msg = (e.message.text || "").trim();
  const today = todayYMDJST();

  // ===== 記録: 体重 =====
  const mWeight = msg.match(/^体重\s*([0-9]+(?:\.[0-9]+)?)\s*$/);
  if (mWeight) {
    const w = parseFloat(mWeight[1]);
    await appendLogs([
      { Date: today, Kind: "Weight", Slot: "-", Text: `${w}kg`, Calories: "", P: "", F: "", C: "", Source: "line", Meta: JSON.stringify({ weight: w }) }
    ]);
    return lineClient.replyMessage(e.replyToken, { type: "text", text: `体重 ${w}kg を記録しました ✅` });
  }

  // ===== 記録: 食事 =====
  const mMeal = msg.match(/^食事\s*(朝|昼|夜|就寝)?\s*[:：]?\s*(.+)$/);
  if (mMeal) {
    const slot = mMeal[1] || "-";
    const text = mMeal[2].trim();
    await appendLogs([{ Date: today, Kind: "Meal", Slot: slot, Text: text, Calories: "", P: "", F: "", C: "", Source: "line", Meta: "{}" }]);
    return lineClient.replyMessage(e.replyToken, { type: "text", text: `食事（${slot}）を記録しました ✅\n${text}` });
  }

  // ===== 記録: トレーニング =====
  const mTr = msg.match(/^(トレ|トレーニング)\s*[:：]?\s*(.+)$/);
  if (mTr) {
    const text = mTr[2].trim();
    const slot = /休養|レスト/i.test(text) ? "休養" : "ジム";
    await appendLogs([{ Date: today, Kind: "Training", Slot: slot, Text: text, Calories: "", P: "", F: "", C: "", Source: "line", Meta: "{}" }]);
    return lineClient.replyMessage(e.replyToken, { type: "text", text: `トレーニング（${slot}）を記録しました ✅\n${text}` });
  }

  // ===== 編集フロー =====
  if (/^編集\s*(朝|昼|夜|就寝|ジム)$/.test(msg)) {
    const slot = msg.replace("編集", "").trim();
    editContext = { slot, draft: "" };
    return lineClient.replyMessage(e.replyToken, { type: "text", text: `「${slot}」の新しい本文を送ってください。` });
  }

  if (editContext && !/^はい$|^いいえ$/.test(msg)) {
    editContext.draft = msg;
    return lineClient.replyMessage(e.replyToken, {
      type: "text",
      text: `以下で更新します。よろしいですか？\n\n【${editContext.slot}】\n${editContext.draft}`,
      quickReply: {
        items: [
          { type: "action", action: { type: "message", label: "はい", text: "はい" } },
          { type: "action", action: { type: "message", label: "いいえ", text: "いいえ" } },
        ],
      },
    });
  }

  if (editContext && /^いいえ$/.test(msg)) {
    editContext = null;
    return lineClient.replyMessage(e.replyToken, { type: "text", text: "キャンセルしました。" });
  }

  if (editContext && /^はい$/.test(msg)) {
    const { slot, draft } = editContext;
    editContext = null;
    const { getWeekAndDayJST } = require("../lib/utils");
    const { rows, idx } = await loadMealPlan();
    const { week, day } = getWeekAndDayJST(process.env.START_DATE);
    const target = rows.find(
      (r) =>
        String(r._rawData[idx.Week]).trim() === String(week) &&
        String(r._rawData[idx.Day]).trim().toLowerCase() === day.toLowerCase() &&
        String(r._rawData[idx.Slot]).trim() === slot
    );
    if (!target) {
      return lineClient.replyMessage(e.replyToken, { type: "text", text: "該当スロットが見つかりませんでした。" });
    }
    target._rawData[idx.Text] = draft;
    await target.save(); // save() は sheets.js の backoff層外だがSDK内リトライ有。必要なら差し替え可。
    return lineClient.replyMessage(e.replyToken, { type: "text", text: `更新完了 ✅\n【${slot}】\n${draft}` });
  }

  // ===== コマンド =====
  if (msg.includes("今日のメニュー")) {
    const menu = await getTodayMenuText();
    return lineClient.replyMessage(e.replyToken, { type: "text", text: menu });
  }

  if (msg.includes("来週メニュー生成")) {
    // 実行は /admin/auto-gen の方が確実。ここでは案内のみ。
    return lineClient.replyMessage(e.replyToken, { type: "text", text: "管理者メニューから実行してください：/admin/auto-gen" });
  }

  return lineClient.replyMessage(e.replyToken, {
    type: "text",
    text: "コマンドを選んでください。",
    quickReply: {
      items: [
        { type: "action", action: { type: "message", label: "今日のメニュー", text: "今日のメニュー" } },
        { type: "action", action: { type: "message", label: "編集 昼", text: "編集 昼" } },
        { type: "action", action: { type: "message", label: "トレ: ベンチ4x8・プル3x10", text: "トレ: ベンチ4x8・プル3x10" } }
      ],
    },
  });
}

module.exports = {
  handleEvent,
  getTodayMenuText,
  getTodaySlotText,
  getLastUserId: () => LAST_USER_ID
};
