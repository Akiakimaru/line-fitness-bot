require("dotenv").config();
const express = require("express");
const line = require("@line/bot-sdk");
const { GoogleSpreadsheet } = require("google-spreadsheet");
const { JWT } = require("google-auth-library");
const cron = require("node-cron");

const app = express();
app.use(express.json());

// === LINE SDK 設定 ===
const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};
const client = new line.Client(config);

// === Google Sheets 認証 ===
const serviceAccountAuth = new JWT({
  email: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON).client_email,
  key: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON).private_key,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID, serviceAccountAuth);

// === ユーザー保持（1人用）===
let LAST_USER_ID = null;

// === デバッグ用エンドポイント ===
app.get("/", (_req, res) => res.send("LINE Fitness Bot OK"));
app.get("/whoami", (_req, res) => res.json({ userIdSet: !!LAST_USER_ID }));

// デバッグ: シート全体を確認
app.get("/debug-scan", async (_req, res) => {
  try {
    await doc.loadInfo();
    const sheet = doc.sheetsByTitle["MealPlan"];
    const rows = await sheet.getRows();
    res.json({
      headers: sheet.headerValues,
      count: rows.length,
      sample: rows.slice(0, 5).map(r => r._rawData),
    });
  } catch (e) {
    res.json({ error: e.toString() });
  }
});

// === 今日のメニュー取得 ===
async function getTodayMenu() {
  await doc.loadInfo();
  const sheet = doc.sheetsByTitle["MealPlan"];
  const rows = await sheet.getRows();

  // START_DATEから週と曜日を算出
  const START_DATE = new Date(process.env.START_DATE);
  const now = new Date();
  const diffDays = Math.floor((now - START_DATE) / (1000 * 60 * 60 * 24));
  const week = Math.floor(diffDays / 7) + 1;

  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const day = days[now.getDay()];

  // 行を抽出（trim & lowerCase）
  const todayRows = rows.filter(
    (r) =>
      String(r.Week).trim() === String(week) &&
      r.Day.trim().toLowerCase() === day.toLowerCase()
  );

  if (todayRows.length === 0) {
    return `今日のメニューは未設定です。\n（Week${week} ${day})`;
  }

  // 食事とトレーニングを分類
  const meals = todayRows.filter((r) => r.Kind === "Meal");
  const trainings = todayRows.filter((r) => r.Kind === "Training");

  let text = `【今日のメニュー】(Week${week} ${day})\n\n🍽 食事\n`;
  meals.forEach((m) => {
    text += `- ${m.Slot}: ${m.Text} （${m.Calories}kcal, P${m.P} F${m.F} C${m.C}）\n  👉 ${m.Tips}\n`;
  });

  if (trainings.length > 0) {
    text += `\n💪 トレーニング\n`;
    trainings.forEach((t) => {
      text += `- ${t.Slot}: ${t.Text}\n  👉 ${t.Tips}\n`;
    });
  }

  return text;
}

// === LINE Webhook ===
app.post("/webhook", line.middleware(config), async (req, res) => {
  try {
    await Promise.all(req.body.events.map(handleEvent));
    res.sendStatus(200);
  } catch (e) {
    console.error("Webhook error", e);
    res.sendStatus(500);
  }
});

// === イベント処理 ===
async function handleEvent(e) {
  if (e.type !== "message" || e.message.type !== "text") return;
  if (e.source?.userId) LAST_USER_ID = e.source.userId;

  const msg = e.message.text.trim();

  if (msg.includes("今日のメニュー")) {
    const menu = await getTodayMenu();
    return client.replyMessage(e.replyToken, { type: "text", text: menu });
  }

  // Quick Reply（例）
  return client.replyMessage(e.replyToken, {
    type: "text",
    text: "何を知りたいですか？",
    quickReply: {
      items: [
        { type: "action", action: { type: "message", label: "今日のメニュー", text: "今日のメニュー" } },
        { type: "action", action: { type: "message", label: "今週メニュー", text: "今週メニュー" } },
      ],
    },
  });
}

// === Cronリマインド（例: 毎日12時に昼食をPush）===
cron.schedule("0 12 * * *", async () => {
  console.log("[cron fired] Lunch Reminder");
  if (!LAST_USER_ID) return;
  const menu = await getTodayMenu();
  await client.pushMessage(LAST_USER_ID, { type: "text", text: "【昼リマインド】\n" + menu });
}, { timezone: "Asia/Tokyo" });

// === サーバー起動 ===
app.listen(process.env.PORT || 3000, () => {
  console.log("Server running");
});
