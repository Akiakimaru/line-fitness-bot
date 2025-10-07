// services/lineHandlers.js
const line = require("@line/bot-sdk");
const { loadMealPlan, registerUser } = require("../lib/sheets");
const { getWeekAndDayJST } = require("../lib/utils");

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};
const client = new line.Client(config);

async function handleEvent(e) {
  // --- userId 登録 ---
  if (e?.source?.userId) {
    await registerUser(e.source.userId);
  }

  if (e.type !== "message" || e.message?.type !== "text") return;
  const msg = (e.message.text || "").trim();

  if (msg.includes("今日のメニュー")) {
    const text = await getTodayMenuText();
    return client.replyMessage(e.replyToken, { type: "text", text });
  }

  return client.replyMessage(e.replyToken, {
    type: "text",
    text: "コマンドを選んでください。",
    quickReply: {
      items: [
        { type: "action", action: { type: "message", label: "今日のメニュー", text: "今日のメニュー" } },
        { type: "action", action: { type: "message", label: "編集 昼", text: "編集 昼" } },
      ],
    },
  });
}

/* ================== メニュー取得 ================== */
async function getTodayMenuText() {
  const { week, day } = getWeekAndDayJST();
  const { rows, idx } = await loadMealPlan();
  const today = rows.filter(
    (r) =>
      String(r._rawData[idx.Week]) === String(week) &&
      String(r._rawData[idx.Day]).toLowerCase() === day.toLowerCase()
  );
  if (!today.length) return `今日のメニューは未設定です。\n（Week${week} ${day})`;

  const meals = today.filter((r) => r._rawData[idx.Kind] === "Meal");
  const trainings = today.filter((r) => r._rawData[idx.Kind] === "Training");

  let text = `【今日のメニュー】(Week${week} ${day})\n\n🍽 食事\n`;
  for (const r of meals) {
    const slot = r._rawData[idx.Slot];
    const desc = r._rawData[idx.Text];
    const kcal = r._rawData[idx.Calories];
    const P = r._rawData[idx.P];
    const F = r._rawData[idx.F];
    const C = r._rawData[idx.C];
    const tips = r._rawData[idx.Tips] || "-";
    text += `- ${slot}: ${desc} （${kcal}kcal, P${P} F${F} C${C}）\n  👉 ${tips}\n`;
  }
  if (trainings.length) {
    text += `\n💪 トレーニング\n`;
    for (const r of trainings) {
      const slot = r._rawData[idx.Slot];
      const desc = r._rawData[idx.Text];
      const tips = r._rawData[idx.Tips] || "-";
      text += `- ${slot}: ${desc}\n  👉 ${tips}\n`;
    }
  }
  return text;
}

module.exports = { handleEvent, getTodayMenuText };
