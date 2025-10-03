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

/* ========= JST helpers ========= */
const TZ = "Asia/Tokyo";
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function nowJST() {
  return new Date(Date.now() + 9 * 60 * 60 * 1000);
}
function parseYMDAsJST(ymd) {
  return new Date(`${ymd}T00:00:00+09:00`);
}
function getWeekAndDayJST() {
  const start = parseYMDAsJST(process.env.START_DATE);
  const now = nowJST();
  const diffDays = Math.floor((now - start) / (1000 * 60 * 60 * 24));
  const week = Math.max(1, Math.floor(diffDays / 7) + 1);
  const day = DAYS[now.getUTCDay()]; // JSTへ+9hした上でgetUTCDay
  return { week, day, jstISO: now.toISOString() };
}

/* ========= State ========= */
let LAST_USER_ID = null;

/* ========= Sheet access helpers ========= */
async function loadMealPlan() {
  await doc.loadInfo();
  const sheet = doc.sheetsByTitle["MealPlan"];
  if (!sheet) throw new Error("MealPlan sheet not found");
  const rows = await sheet.getRows();

  // ヘッダー → インデックス
  const H = sheet.headerValues; // ["Week","Day","Kind","Slot","Text","Calories","P","F","C","Tips"]
  const idx = {
    Week: H.indexOf("Week"),
    Day: H.indexOf("Day"),
    Kind: H.indexOf("Kind"),
    Slot: H.indexOf("Slot"),
    Text: H.indexOf("Text"),
    Calories: H.indexOf("Calories"),
    P: H.indexOf("P"),
    F: H.indexOf("F"),
    C: H.indexOf("C"),
    Tips: H.indexOf("Tips"),
  };
  // インデックスが1つでも無ければエラー
  Object.entries(idx).forEach(([k, v]) => {
    if (v === -1) throw new Error(`Header "${k}" not found in MealPlan`);
  });

  return { sheet, rows, idx, headers: H };
}

function cell(row, i) {
  return String((row._rawData && row._rawData[i]) ?? "").trim();
}

/* ========= Debug endpoints ========= */
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
    const { headers, rows } = await loadMealPlan();
    res.json({
      headers,
      count: rows.length,
      sample: rows.slice(0, 5).map((r) => r._rawData),
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});
app.get("/debug-today", async (_req, res) => {
  try {
    const { week, day } = getWeekAndDayJST();
    const { rows, idx, headers } = await loadMealPlan();
    const matches = rows
      .filter(
        (r) =>
          cell(r, idx.Week) === String(week) &&
          cell(r, idx.Day).toLowerCase() === day.toLowerCase()
      )
      .map((r) => r._rawData);
    res.json({ target: { week, day }, headers, hitCount: matches.length, matches });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

/* ========= Build today text ========= */
async function getTodayMenu() {
  const { week, day } = getWeekAndDayJST();
  const { rows, idx } = await loadMealPlan();

  const today = rows.filter(
    (r) =>
      cell(r, idx.Week) === String(week) &&
      cell(r, idx.Day).toLowerCase() === day.toLowerCase()
  );

  if (today.length === 0) {
    return `今日のメニューは未設定です。\n（Week${week} ${day})`;
  }

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
  if (msg.toLowerCase().includes("debug week")) {
    const info = getWeekAndDayJST();
    return client.replyMessage(e.replyToken, {
      type: "text",
      text: JSON.stringify(info),
    });
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
