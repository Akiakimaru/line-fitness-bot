// index.js
require("dotenv").config();
const express = require("express");
const line = require("@line/bot-sdk");
const { GoogleSpreadsheet } = require("google-spreadsheet");
const { JWT } = require("google-auth-library");
const cron = require("node-cron");

const app = express();
app.use(express.json());

// LINE 設定
const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};
const client = new line.Client(config);

// Google Sheets 設定
const SCOPES = ["https://www.googleapis.com/auth/spreadsheets"];
const GOOGLE_JSON = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);

const auth = new JWT({
  email: GOOGLE_JSON.client_email,
  key: GOOGLE_JSON.private_key,
  scopes: SCOPES,
});

const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID, auth);

async function initSheet() {
  await doc.loadInfo();
  console.log("✅ Google Sheet connected:", doc.title);
}

// 今日のメニューを取得
async function getTodayMenu() {
  await initSheet();
  const sheet = doc.sheetsByTitle["MealPlan"];
  const rows = await sheet.getRows();

  // 今日の週/曜日を計算
  const START_DATE = new Date(process.env.START_DATE);
  const now = new Date();
  const diffDays = Math.floor((now - START_DATE) / (1000 * 60 * 60 * 24));
  const week = Math.floor(diffDays / 7) + 1;
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const day = days[now.getDay()];

  // 抽出
  const todayRows = rows.filter(
    (r) => String(r.Week) === String(week) && r.Day === day
  );

  if (todayRows.length === 0) {
    return `今日のメニューは未設定です。（Week${week} ${day})`;
  }

  let msg = `📅 今日のメニュー（Week${week} ${day}）\n\n`;
  for (const r of todayRows) {
    msg += `【${r.Kind} - ${r.Slot}】\n${r.Text}\n`;
    if (r.Calories || r.P || r.F || r.C) {
      msg += `カロリー: ${r.Calories}kcal P:${r.P} F:${r.F} C:${r.C}\n`;
    }
    if (r.Tips) msg += `💡 ${r.Tips}\n`;
    msg += `\n`;
  }
  return msg;
}

// LINE イベント処理
async function handleEvent(event) {
  if (event.type !== "message" || event.message.type !== "text") {
    return Promise.resolve(null);
  }

  const text = event.message.text;

  if (text.includes("今日のメニュー")) {
    const reply = await getTodayMenu();
    return client.replyMessage(event.replyToken, { type: "text", text: reply });
  }

  if (text === "/whoami") {
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: JSON.stringify({ userId: event.source.userId }),
    });
  }

  return client.replyMessage(event.replyToken, {
    type: "text",
    text: "コマンドが認識されませんでした。",
  });
}

// Webhook
app.post("/webhook", line.middleware(config), (req, res) => {
  Promise.all(req.body.events.map(handleEvent))
    .then((result) => res.json(result))
    .catch((err) => {
      console.error("Webhook error:", err);
      res.status(500).end();
    });
});

// デバッグ用エンドポイント
app.get("/debug-scan", async (req, res) => {
  try {
    await initSheet();
    const sheet = doc.sheetsByTitle["MealPlan"];
    const rows = await sheet.getRows();
    res.json({
      headers: sheet.headerValues,
      count: rows.length,
      sample: rows.slice(0, 5).map((r) => r._rawData),
    });
  } catch (err) {
    res.json({ error: err.toString() });
  }
});

// Render 起動確認
app.get("/", (req, res) => res.send("Bot is running!"));

// ポート起動
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running on ${port}`));

// ====== CRON ======
// 毎朝7時に今日のメニューをPush通知（例）
cron.schedule("0 7 * * *", async () => {
  try {
    const msg = await getTodayMenu();
    const userId = process.env.LAST_USER_ID; // 保存したユーザーID
    if (userId) {
      await client.pushMessage(userId, { type: "text", text: msg });
      console.log("✅ Daily push sent:", msg);
    } else {
      console.log("⚠️ No userId set");
    }
  } catch (err) {
    console.error("Cron push error:", err);
  }
});
