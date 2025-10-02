require("dotenv").config();
const express = require("express");
const line = require("@line/bot-sdk");
const { GoogleSpreadsheet } = require("google-spreadsheet");
const OpenAI = require("openai");
const cron = require("node-cron");

const app = express();

// --- LINE設定 ---
const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};
const client = new line.Client(config);

// --- OpenAI設定 ---
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// --- ユーザー保持 ---
let LAST_USER_ID = null;

// --- Google Sheets 設定 ---
const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID);
const serviceAccount = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);

async function initSheet() {
  await doc.useServiceAccountAuth(serviceAccount);
  await doc.loadInfo();
  return doc.sheetsByTitle["MealPlan"];
}

// --- 日付計算ヘルパー ---
function getWeekDay() {
  const startDate = new Date(process.env.START_DATE); // Week1の月曜
  const today = new Date();
  const diffDays = Math.floor((today - startDate) / (1000 * 60 * 60 * 24));
  const week = Math.floor(diffDays / 7) + 1;
  const dayIdx = diffDays % 7;
  const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return { week, day: dayNames[dayIdx] };
}

// --- スプレッドシートからメニュー取得 ---
async function getTodayMenu() {
  const { week, day } = getWeekDay();
  const sheet = await initSheet();
  await sheet.loadHeaderRow();

  const rows = await sheet.getRows();
  return rows.filter(r => r.Week == week && r.Day === day);
}

// --- LINE応答 ---
app.get("/", (_req, res) => res.send("LINE Bot Server OK"));
app.get("/whoami", (_req, res) => res.json({ userIdSet: !!LAST_USER_ID }));
app.get("/push-test", async (_req, res) => {
  if (!LAST_USER_ID) return res.send("userId未取得：Botに話しかけてください。");
  await client.pushMessage(LAST_USER_ID, { type: "text", text: "【テストPush】起きろ！" });
  res.send("Push送信OK");
});

// --- Webhook ---
app.post("/webhook", line.middleware(config), async (req, res) => {
  try {
    await Promise.all(req.body.events.map(handleEvent));
    res.sendStatus(200);
  } catch (e) {
    console.error("Webhook error", e);
    res.sendStatus(500);
  }
});

async function handleEvent(e) {
  if (!e || e.type !== "message") return;
  if (e.source?.userId) LAST_USER_ID = e.source.userId;

  if (e.message.type === "text") {
    const t = (e.message.text || "").trim();

    if (t.includes("今日のメニュー")) {
      const menu = await getTodayMenu();
      if (!menu.length) {
        return client.replyMessage(e.replyToken, {
          type: "text",
          text: "今日のメニューがシートに見つかりません。"
        });
      }
      const text = menu.map(r =>
        `【${r.Slot}】${r.Text}\n(${r.Calories}kcal P:${r.P} F:${r.F} C:${r.C})\nTips:${r.Tips}`
      ).join("\n\n");
      return client.replyMessage(e.replyToken, { type: "text", text });
    }

    if (t.includes("来週メニュー生成")) {
      await generateNextWeekMenu();
      return client.replyMessage(e.replyToken, {
        type: "text", text: "来週分のメニューを自動生成して保存しました。"
      });
    }

    return client.replyMessage(e.replyToken, { type: "text", text: "OK、受け取った。" });
  }
}

// --- 週末自動生成 ---
async function generateNextWeekMenu() {
  const { week } = getWeekDay();
  const nextWeek = week + 1;

  const prompt = `
あなたは栄養士兼トレーナーです。減量期の男性向けに1週間分の食事（朝/昼/夜/就寝）とトレーニングを作成してください。
フォーマットはCSV形式: Week,Day,Kind,Slot,Text,Calories,P,F,C,Tips
DayはSun~Sat、KindはMeal or Training。
`;

  const res = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
  });

  const csv = res.choices[0].message.content.trim();
  const lines = csv.split("\n").slice(1);

  const sheet = await initSheet();

  for (const line of lines) {
    const [Week, Day, Kind, Slot, Text, Calories, P, F, C, Tips] = line.split(",");
    // 重複チェック
    const rows = await sheet.getRows();
    const exists = rows.find(r => r.Week == nextWeek && r.Day === Day && r.Slot === Slot);
    if (!exists) {
      await sheet.addRow({ Week: nextWeek, Day, Kind, Slot, Text, Calories, P, F, C, Tips });
    }
  }
}

// --- 月初アーカイブ処理 ---
async function archiveOldWeeks() {
  const { week } = getWeekDay();
  const sheet = await initSheet();
  const rows = await sheet.getRows();
  const archiveWeek = week - 4;

  if (archiveWeek <= 0) return;

  const old = rows.filter(r => r.Week <= archiveWeek);
  if (!old.length) return;

  // アーカイブシート名
  const now = new Date();
  const archiveName = `Archive_${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}`;

  let archiveSheet = doc.sheetsByTitle[archiveName];
  if (!archiveSheet) {
    archiveSheet = await doc.addSheet({ title: archiveName, headerValues: sheet.headerValues });
  }

  for (const r of old) {
    await archiveSheet.addRow(r._rawData);
    await r.delete();
  }
}

// --- 定時ジョブ ---
cron.schedule("0 8 * * *", async () => { // 毎朝8時にメニュー送信
  if (!LAST_USER_ID) return;
  const menu = await getTodayMenu();
  if (!menu.length) return;
  const text = menu.map(r =>
    `【${r.Slot}】${r.Text}\n(${r.Calories}kcal P:${r.P} F:${r.F} C:${r.C})\nTips:${r.Tips}`
  ).join("\n\n");
  await client.pushMessage(LAST_USER_ID, { type: "text", text: text });
}, { timezone: "Asia/Tokyo" });

cron.schedule("0 23 * * 0", generateNextWeekMenu, { timezone: "Asia/Tokyo" }); // 日曜23時: 来週メニュー生成
cron.schedule("0 1 1 * *", archiveOldWeeks, { timezone: "Asia/Tokyo" });       // 月初1日1時: アーカイブ

// --- サーバー起動 ---
app.listen(process.env.PORT || 3000, () => {
  console.log("Server OK");
});
