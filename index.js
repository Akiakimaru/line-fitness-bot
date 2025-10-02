require("dotenv").config();
const express = require("express");
const line = require("@line/bot-sdk");
const OpenAI = require("openai");
const cron = require("node-cron");
const { GoogleSpreadsheet } = require("google-spreadsheet");

const app = express();
app.use(express.json());

// ===== LINE =====
const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};
const client = new line.Client(lineConfig);

// ===== OpenAI =====
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ===== Google Sheets =====
const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID);
async function initSheet(sheetName = "MealPlan") {
  await doc.useServiceAccountAuth(JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON));
  await doc.loadInfo();
  const sheet = doc.sheetsByTitle[sheetName];
  if (!sheet) throw new Error(`Sheet '${sheetName}' not found`);
  return sheet;
}

// ===== State =====
let LAST_USER_ID = null;
const TZ = "Asia/Tokyo";
const WEEKDAYS = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];

// ===== Week auto calc =====
function getCurrentWeek() {
  const start = new Date(process.env.START_DATE); // e.g., 2025-10-06 (Mon)
  const now = new Date();
  const diffWeeks = Math.floor((now - start) / (1000*60*60*24*7));
  return diffWeeks + 1;
}
function getTodayKeys(d = new Date()) {
  const day = WEEKDAYS[d.getDay()];
  const week = getCurrentWeek();
  return { week, day };
}

// ===== Query helpers =====
async function getTodayRows() {
  const sheet = await initSheet("MealPlan");
  const rows = await sheet.getRows();
  const { week, day } = getTodayKeys();
  return rows.filter(r => Number(r.Week) === week && String(r.Day) === day);
}
async function findMealSlot(slotName) {
  const today = await getTodayRows();
  return today.find(r => r.Kind === "Meal" && String(r.Slot) === slotName) || null;
}
async function findTrainingToday() {
  const today = await getTodayRows();
  return today.find(r => r.Kind === "Training") || null;
}

// ===== Format helpers =====
function num(n) { const v = Number(n); return Number.isFinite(v) ? v : 0; }
function fmtMeal(bullet, row) {
  const cal = num(row?.Calories), p = num(row?.P), f = num(row?.F), c = num(row?.C);
  return `${bullet}【${row.Slot}】\n${row.Text}\n${cal}kcal (P${p}/F${f}/C${c})\nTips: ${row.Tips || "-"}`;
}
function fmtTraining(row) {
  return `【今日のトレーニング】\n${row.Text}\nTips: ${row.Tips || "-"}`;
}

// ===== “今日のメニュー” 一括返信 =====
async function getTodayPlanText() {
  const { week, day } = getTodayKeys();
  const rows = await getTodayRows();
  if (!rows.length) return `今日のメニューは未設定です。（Week${week} ${day})`;

  const meals = rows.filter(r => r.Kind === "Meal");
  const train = rows.find(r => r.Kind === "Training");

  let total = { cal: 0, p: 0, f: 0, c: 0 };
  let lines = [`【今日のメニュー】(Week${week} ${day})`];

  // 並び順固定（朝→昼→夜→就寝）
  for (const slot of ["朝","昼","夜","就寝"]) {
    const m = meals.find(r => r.Slot === slot);
    if (m) {
      lines.push("", fmtMeal("🍴 ", m));
      total.cal += num(m.Calories); total.p += num(m.P); total.f += num(m.F); total.c += num(m.C);
    }
  }
  lines.push("", `=== 合計 ===\n${total.cal} kcal (P${total.p}/F${total.f}/C${total.c})`);
  if (train) lines.push("", "🏋️‍♂️ " + fmtTraining(train));
  return lines.join("\n");
}

// ===== 週末：来週メニュー自動生成 → MealPlanに保存 =====
async function generateNextWeekMeals() {
  const nextWeek = getCurrentWeek() + 1;

  const sys = "あなたは厳しめの日本語の栄養士兼トレーナー。ダイエット向けに週次プランを作る。短く端的。";
  const user = `
対象: 28歳男性/170cm/80kg 減量。魚は刺身中心、夜は低糖質、週3回まで同メニューOK。オートミールは飽き対策で変化を付ける。
出力: CSV（ヘッダ必須） Day,Kind,Slot,Text,Calories,P,F,C,Tips
- Day: Sun,Mon, Tue, Wed, Thu, Fri, Sat
- Kind: "Meal" または "Training"
- Slot: Meal→朝/昼/夜/就寝, Training→ジム or 休養
- Calories,P,F,C は数値（空OK：Trainingは空で可）
- 文末の装飾や余計な説明は不要（CSVのみ）
`;

  const res = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.3,
    messages: [
      { role: "system", content: sys },
      { role: "user", content: user },
    ],
  });

  const csv = (res.choices?.[0]?.message?.content || "").trim();
  const lines = csv.split("\n").map(s => s.trim()).filter(Boolean);
  if (!/^Day,?Kind,?Slot,?Text,?Calories,?P,?F,?C,?Tips/i.test(lines[0])) {
    throw new Error("CSVヘッダが想定と違います。モデル出力を確認してください。");
  }

  const sheet = await initSheet("MealPlan");
  for (const line of lines.slice(1)) {
    // CSV中のカンマを想定し、単純split。必要なら厳密CSVパーサに置換可。
    const parts = line.split(",");
    const [Day, Kind, Slot, Text, Calories, P, F, C, Tips] = parts;
    await sheet.addRow({
      Week: nextWeek,
      Day: Day?.trim(),
      Kind: Kind?.trim(),
      Slot: Slot?.trim(),
      Text: Text?.trim(),
      Calories: (Calories || "").trim(),
      P: (P || "").trim(),
      F: (F || "").trim(),
      C: (C || "").trim(),
      Tips: (Tips || "").trim(),
    });
  }
  return `来週(Week${nextWeek})のメニューを作成し、保存しました。`;
}

// ===== 月初：先月分をアーカイブへ移動 =====
async function archiveLastMonth() {
  await doc.useServiceAccountAuth(JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON));
  await doc.loadInfo();
  const sheet = doc.sheetsByTitle["MealPlan"];
  if (!sheet) return;

  const rows = await sheet.getRows();
  if (!rows.length) return;

  // 先月の "Week" をざっくり基準に：現在週-4 以前をアーカイブ対象とする（4週=約1ヶ月）
  const currentWeek = getCurrentWeek();
  const cutoff = currentWeek - 4;

  const now = new Date();
  const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const ym = `${lastMonth.getFullYear()}${String(lastMonth.getMonth() + 1).padStart(2, "0")}`;
  const archiveName = `Archive_${ym}`;

  let archive = doc.sheetsByTitle[archiveName];
  if (!archive) {
    archive = await doc.addSheet({ title: archiveName, headerValues: sheet.headerValues });
  }

  for (const r of rows) {
    const wk = Number(r.Week);
    if (Number.isFinite(wk) && wk <= cutoff) {
      await archive.addRow(r._rawData);
      await r.delete();
    }
  }
  console.log(`[Archive] moved rows (<= Week${cutoff}) to ${archiveName}`);
}

// ===== Webhook =====
app.post("/webhook", line.middleware(lineConfig), async (req, res) => {
  try {
    await Promise.all((req.body.events || []).map(async (e) => {
      if (e?.source?.userId) LAST_USER_ID = e.source.userId;

      if (e.type === "message" && e.message?.type === "text") {
        const t = (e.message.text || "").trim();
        if (t.includes("今日のメニュー")) {
          const msg = await getTodayPlanText();
          return client.replyMessage(e.replyToken, { type: "text", text: msg });
        }
        if (t.includes("来週メニュー生成")) {
          const msg = await generateNextWeekMeals();
          return client.replyMessage(e.replyToken, { type: "text", text: msg });
        }
        // デフォルト：クイック
        return client.replyMessage(e.replyToken, {
          type: "text",
          text: "コマンド: 今日のメニュー / 来週メニュー生成",
          quickReply: {
            items: [
              { type: "action", action: { type: "message", label: "今日のメニュー", text: "今日のメニュー" } },
              { type: "action", action: { type: "message", label: "来週メニュー生成", text: "来週メニュー生成" } },
            ],
          },
        });
      }
    }));
    res.sendStatus(200);
  } catch (err) {
    console.error("Webhook error", err);
    res.sendStatus(500);
  }
});

// ===== Push: スプシから内容を拾って送る =====
async function pushSlot(slotName, fallbackText) {
  if (!LAST_USER_ID) return;
  try {
    if (slotName === "ジム前") {
      const tr = await findTrainingToday();
      if (tr) {
        return client.pushMessage(LAST_USER_ID, { type: "text", text: fmtTraining(tr) });
      }
      return client.pushMessage(LAST_USER_ID, { type: "text", text: fallbackText });
    }

    if (slotName === "ジム後") {
      // 朝の要約 + リカバリー促し
      const morning = await findMealSlot("朝");
      if (morning) {
        const cal = num(morning.Calories), p = num(morning.P), f = num(morning.F), c = num(morning.C);
        const text = `【ジム後】\nまずはプロテイン。\nその後の朝食:\n${morning.Text}\n${cal}kcal (P${p}/F${f}/C${c})\nTips: ${morning.Tips || "-"}\n水分も追加。`;
        return client.pushMessage(LAST_USER_ID, { type: "text", text });
      }
      return client.pushMessage(LAST_USER_ID, { type: "text", text: fallbackText });
    }

    // 通常の食事スロット
    const slotMap = { "起床":"朝", "昼食":"昼", "夕食":"夜", "就寝前":"就寝", "間食":"間食" };
    const targetSlot = slotMap[slotName];
    if (targetSlot) {
      const meal = await findMealSlot(targetSlot);
      if (meal) {
        return client.pushMessage(LAST_USER_ID, { type: "text", text: fmtMeal("🍴 ", meal) });
      }
    }

    // フォールバック
    return client.pushMessage(LAST_USER_ID, { type: "text", text: fallbackText });
  } catch (e) {
    console.error(`[push ${slotName}] error`, e);
  }
}

// ===== CRON（JST） =====
// 5:50 起床（朝メニュー提示）
cron.schedule("50 5 * * *", () => pushSlot("起床", "【起床】水500ml＋EAA。朝食までに体を起こせ。"), { timezone: TZ });
// 6:00 ジム前（今日のトレーニング）
cron.schedule("0 6 * * *", () => pushSlot("ジム前", "【ジム前】動的ストレッチ。関節を温めろ。"), { timezone: TZ });
// 7:30 ジム後（朝食要約）
cron.schedule("30 7 * * *", () => pushSlot("ジム後", "【ジム後】プロテイン摂れ。朝食は計画どおり。"), { timezone: TZ });
// 12:00 昼食（昼メニュー）
cron.schedule("0 12 * * *", () => pushSlot("昼食", "【昼食】予定どおり。食後20分歩け。"), { timezone: TZ });
// 15:00 間食（スロット無ければ既定）
cron.schedule("0 15 * * *", () => pushSlot("間食", "【間食】プロテイン＋素焼きナッツ一握り。ストレッチ2分。"), { timezone: TZ });
// 19:00 夕食（夜メニュー）
cron.schedule("0 19 * * *", () => pushSlot("夕食", "【夕食】計画どおり。糖質は控えめに。"), { timezone: TZ });
// 23:00 就寝前（就寝メニュー）
cron.schedule("0 23 * * *", () => pushSlot("就寝前", "【就寝前】ヨーグルト＋プロテイン。23時は電源OFF。"), { timezone: TZ });

// 週末（日曜20:00）に来週メニュー自動生成
cron.schedule("0 20 * * 0", async () => {
  try {
    const msg = await generateNextWeekMeals();
    if (LAST_USER_ID) await client.pushMessage(LAST_USER_ID, { type: "text", text: msg });
  } catch (e) {
    console.error("[cron nextweek] error", e);
  }
}, { timezone: TZ });

// 月初（1日0:00）にアーカイブ
cron.schedule("0 0 1 * *", async () => {
  try {
    await archiveLastMonth();
  } catch (e) {
    console.error("[cron archive] error", e);
  }
}, { timezone: TZ });

// ===== Health endpoints =====
app.get("/", (_req, res) => res.send("LINE Bot Server OK"));
app.get("/whoami", (_req, res) => res.json({ userIdSet: !!LAST_USER_ID, lastUserId: LAST_USER_ID }));

// ===== Start =====
app.listen(process.env.PORT || 3000, () => console.log("Server OK"));
