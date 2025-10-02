require("dotenv").config();
const express = require("express");
const line = require("@line/bot-sdk");
const { GoogleSpreadsheet } = require("google-spreadsheet");
const { JWT } = require("google-auth-library");
const cron = require("node-cron");

const app = express(); // ← webhook前に body-parser を付けない

/* ========= LINE ========= */
const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};
const client = new line.Client(config);

/* ========= Google Sheets (v5) ========= */
const serviceAccount = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
const jwt = new JWT({
  email: serviceAccount.client_email,
  key: serviceAccount.private_key,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID, jwt);

/* ========= Helpers: JSTで週/曜日計算 ========= */
const TZ = "Asia/Tokyo";
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// 現在(JST)のDateオブジェクト（内部はUTCだが「+9h」シフトした瞬間時刻）
function nowJST() {
  return new Date(Date.now() + 9 * 60 * 60 * 1000);
}

// "YYYY-MM-DD" を JST の 00:00 に固定して Date を作る
function parseYMDAsJST(ymd) {
  // 例: "2025-09-29T00:00:00+09:00" をパース
  return new Date(`${ymd}T00:00:00+09:00`);
}

// JST基準で week/day を返す
function getWeekAndDayJST() {
  const start = parseYMDAsJST(process.env.START_DATE);
  const now = nowJST();
  const diffDays = Math.floor((now - start) / (1000 * 60 * 60 * 24));
  const week = Math.max(1, Math.floor(diffDays / 7) + 1);
  // JSTにずらしたDateに対して getUTCDay() を使うとJSTの曜日が取れる
  const day = DAYS[now.getUTCDay()];
  return { week, day, jstISO: now.toISOString() };
}

/* ========= 状態 ========= */
let LAST_USER_ID = null;

/* ========= Debug Endpoints ========= */
app.get("/", (_req, res) => res.send("LINE Fitness Bot OK"));
app.get("/whoami", (_req, res) =>
  res.json({ userIdSet: !!LAST_USER_ID, lastUserId: LAST_USER_ID })
);
app.get("/debug-week", (_req, res) => {
  const info = getWeekAndDayJST();
  res.json({ START_DATE: process.env.START_DATE, ...info });
});
app.get("/debug-scan", async (_req, res) => {
  try {
    await doc.loadInfo();
    const sheet = doc.sheetsByTitle["MealPlan"];
    const rows = await sheet.getRows();
    res.json({
      headers: sheet.headerValues,
      count: rows.length,
      sample: rows.slice(0, 5).map((r) => r._rawData),
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

/* ========= 今日のメニュー取得（JST基準） ========= */
async function getTodayMenu() {
  await doc.loadInfo();
  const sheet = doc.sheetsByTitle["MealPlan"];
  if (!sheet) return "エラー: MealPlan シートが見つかりません。";
  const rows = await sheet.getRows();

  const { week, day } = getWeekAndDayJST();

  // 文字揺れを吸収（trim & lower）
  const todayRows = rows.filter(
    (r) =>
      String(r.Week ?? "").trim() === String(week) &&
      String(r.Day ?? "").trim().toLowerCase() === day.toLowerCase()
  );

  if (todayRows.length === 0) {
    return `今日のメニューは未設定です。\n（Week${week} ${day})`;
  }

  const meals = todayRows.filter((r) => String(r.Kind).trim() === "Meal");
  const trainings = todayRows.filter((r) => String(r.Kind).trim() === "Training");

  let text = `【今日のメニュー】(Week${week} ${day})\n\n🍽 食事\n`;
  for (const m of meals) {
    const cal = String(m.Calories ?? "").trim();
    const P = String(m.P ?? "").trim();
    const F = String(m.F ?? "").trim();
    const C = String(m.C ?? "").trim();
    const tips = (m.Tips && String(m.Tips).trim()) || "-";
    text += `- ${m.Slot}: ${m.Text} （${cal}kcal, P${P} F${F} C${C}）\n  👉 ${tips}\n`;
  }

  if (trainings.length) {
    text += `\n💪 トレーニング\n`;
    for (const t of trainings) {
      const tips = (t.Tips && String(t.Tips).trim()) || "-";
      text += `- ${t.Slot}: ${t.Text}\n  👉 ${tips}\n`;
    }
  }

  return text;
}

/* ========= LINE Webhook ========= */
// 署名検証の前に body-parser を入れないこと！
app.post("/webhook", line.middleware(config), async (req, res) => {
  try {
    await Promise.all((req.body.events || []).map(handleEvent));
    res.sendStatus(200);
  } catch (e) {
    console.error("Webhook error", e);
    res.sendStatus(500);
  }
});

async function handleEvent(e) {
  if (e?.source?.userId) LAST_USER_ID = e.source.userId;
  if (e.type !== "message" || e.message?.type !== "text") return;

  const msg = (e.message.text || "").trim();

  if (msg.includes("今日のメニュー")) {
    const menu = await getTodayMenu();
    return client.replyMessage(e.replyToken, { type: "text", text: menu });
  }

  return client.replyMessage(e.replyToken, {
    type: "text",
    text: "コマンドを選んでください。",
    quickReply: {
      items: [
        { type: "action", action: { type: "message", label: "今日のメニュー", text: "今日のメニュー" } },
        { type: "action", action: { type: "message", label: "デバッグ(週/曜日)", text: "debug week" } },
      ],
    },
  });
}

/* ========= CRON（例：毎日12:00に昼Push） ========= */
cron.schedule(
  "0 12 * * *",
  async () => {
    console.log("[cron fired] Lunch Reminder (JST)");
    if (!LAST_USER_ID) return;
    const menu = await getTodayMenu();
    await client.pushMessage(LAST_USER_ID, {
      type: "text",
      text: "【昼リマインド】\n" + menu,
    });
  },
  { timezone: TZ }
);

/* ========= webhook 以外のルート用に JSON パーサを後ろで有効化 ========= */
app.use(express.json());

/* ========= 起動 ========= */
app.listen(process.env.PORT || 3000, () => {
  console.log("Server running");
});
