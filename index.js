require("dotenv").config();
const express = require("express");
const line = require("@line/bot-sdk");
const { GoogleSpreadsheet } = require("google-spreadsheet");
const cron = require("node-cron");

const app = express();
app.use(express.json());

// --- LINE SDK 設定 ---
const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};
const client = new line.Client(config);

// --- Google Sheets 設定 ---
const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID);

// サービスアカウント認証
async function initSheet() {
  await doc.useServiceAccountAuth(JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON));
  await doc.loadInfo();
}

// シート取得
async function getSheet(title) {
  await initSheet();
  const sheet = doc.sheetsByTitle[title];
  if (!sheet) throw new Error(`シート ${title} が見つかりません`);
  return { sheet };
}

// --- ユーティリティ ---
const toHalfWidthNum = (v) =>
  String(v ?? "").replace(/[０-９]/g, (s) =>
    String.fromCharCode(s.charCodeAt(0) - 0xFEE0)
  );

const toIntStrict = (v) => {
  const s = toHalfWidthNum(v).replace(/[^\d-]/g, "").trim();
  return s ? parseInt(s, 10) : NaN;
};

const toNum = (v) => {
  const s = toHalfWidthNum(v).replace(/[^\d.-]/g, "");
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
};

const normDay = (d) => {
  if (!d) return "";
  const map = {
    sun: "Sun",
    mon: "Mon",
    tue: "Tue",
    wed: "Wed",
    thu: "Thu",
    fri: "Fri",
    sat: "Sat",
  };
  const key = String(d).trim().toLowerCase().slice(0, 3);
  return map[key] || "";
};

// --- 行を安全にオブジェクト化 ---
function rowToObj(row, sheet) {
  const obj = {};
  const headers = sheet.headerValues || [];
  const raw = row._rawData || [];
  headers.forEach((h, i) => {
    obj[h] = raw[i] ?? "";
  });
  return obj;
}

// --- 今日の日付キー ---
function getTodayKey() {
  const start = new Date(process.env.START_DATE); // YYYY-MM-DD
  const now = new Date();

  const diffDays = Math.floor((now - start) / (1000 * 60 * 60 * 24));
  const week = Math.floor(diffDays / 7) + 1;

  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const day = days[now.getDay()];

  return { week, day, jstISO: now.toISOString() };
}

// --- 今日の行を取得 ---
async function getTodayRows() {
  const { week, day } = getTodayKey();
  const { sheet } = await getSheet("MealPlan");
  await sheet.loadHeaderRow();

  const rows = await sheet.getRows();
  const today = normDay(day);

  return rows
    .map((r) => rowToObj(r, sheet))
    .filter((o) => toIntStrict(o.Week) === week && normDay(o.Day) === today);
}

// --- Slot検索 ---
async function findMealSlot(slot) {
  const rows = await getTodayRows();
  return rows.find(
    (o) => o.Kind === "Meal" && String(o.Slot).trim() === slot
  );
}

async function findTrainingToday() {
  const rows = await getTodayRows();
  return rows.find((o) => o.Kind === "Training");
}

// --- 今日のメニュー構築 ---
async function buildTodayPlanText() {
  const { week, day } = getTodayKey();
  const rows = await getTodayRows();
  if (!rows.length) return `今日のメニューは未設定です。（Week${week} ${day})`;

  const order = ["朝", "昼", "夜", "就寝"];
  const meals = rows.filter((o) => o.Kind === "Meal");
  const train = rows.find((o) => o.Kind === "Training");

  let total = { kcal: 0, p: 0, f: 0, c: 0 };
  const out = [`【今日のメニュー】(Week${week} ${day})`];

  for (const s of order) {
    const m = meals.find((o) => String(o.Slot).trim() === s);
    if (m) {
      out.push(
        "",
        `🍴 【${m.Slot}】\n${m.Text}\n${toNum(m.Calories)}kcal (P${toNum(
          m.P
        )}/F${toNum(m.F)}/C${toNum(m.C)})\nTips: ${m.Tips || "-"}`
      );
      total.kcal += toNum(m.Calories);
      total.p += toNum(m.P);
      total.f += toNum(m.F);
      total.c += toNum(m.C);
    }
  }
  out.push(
    "",
    `=== 合計 ===\n${total.kcal} kcal (P${total.p}/F${total.f}/C${total.c})`
  );
  if (train)
    out.push(
      "",
      `🏋️‍♂️ 【今日のトレーニング】\n${train.Text}\nTips: ${train.Tips || "-"}`
    );
  return out.join("\n");
}

// --- LINE Webhook ---
let LAST_USER_ID = null;

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
      const plan = await buildTodayPlanText();
      return client.replyMessage(e.replyToken, { type: "text", text: plan });
    }

    if (t.includes("起床")) {
      const m = await findMealSlot("朝");
      return client.replyMessage(e.replyToken, {
        type: "text",
        text: m ? `【起床】\n${m.Text}` : "未設定",
      });
    }

    // デフォルト応答
    return client.replyMessage(e.replyToken, {
      type: "text",
      text: "コマンドが認識できません。例: 今日のメニュー, 起床",
    });
  }
}

// --- Debug用 ---
app.get("/debug-scan", async (_req, res) => {
  try {
    const { week, day } = getTodayKey();
    const { sheet } = await getSheet("MealPlan");
    await sheet.loadHeaderRow();
    const rows = await sheet.getRows();

    const dump = rows.slice(0, 40).map((r) => {
      const o = rowToObj(r, sheet);
      return {
        parsedWeek: toIntStrict(o.Week),
        normDay: normDay(o.Day),
        rawData: r._rawData,
      };
    });

    res.json({ headers: sheet.headerValues, target: { week, day }, count: rows.length, dump });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// --- サーバ起動 ---
app.listen(process.env.PORT || 3000, () => {
  console.log("Server OK");
});
