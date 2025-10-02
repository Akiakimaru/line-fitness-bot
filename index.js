require("dotenv").config();
const express = require("express");
const line = require("@line/bot-sdk");
const { GoogleSpreadsheet } = require("google-spreadsheet");
const { JWT } = require("google-auth-library");
const OpenAI = require("openai");
const cron = require("node-cron");

const app = express(); // ← 重要: 署名検証のため express.json() は使わない

/* ========== LINE 設定 ========== */
const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};
const client = new line.Client(lineConfig);

/* ========== OpenAI 設定 ========== */
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/* ========== Google Sheets v5 認証 ========== */
function newDoc() {
  const sa = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new JWT({
    email: sa.client_email,
    key: sa.private_key,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  // v5 はコンストラクタに auth を渡す
  return new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID, auth);
}

/** MealPlan を返す（なければ作成） */
async function getSheet(sheetName = "MealPlan") {
  const doc = newDoc();
  await doc.loadInfo();
  let sheet = doc.sheetsByTitle[sheetName];
  if (!sheet) {
    sheet = await doc.addSheet({
      title: sheetName,
      headerValues: ["Week", "Day", "Kind", "Slot", "Text", "Calories", "P", "F", "C", "Tips"],
    });
  }
  return { doc, sheet };
}

/* ========== 共有状態 / 共通関数 ========== */
let LAST_USER_ID = null;
const TZ = "Asia/Tokyo";
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const toNum = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

function getCurrentWeek() {
  // .env: START_DATE=YYYY-MM-DD（Week1の月曜）
  const start = new Date(process.env.START_DATE);
  const now = new Date();
  const diffWeeks = Math.floor((now - start) / (1000 * 60 * 60 * 24 * 7));
  return diffWeeks + 1;
}
function getTodayKey() {
  const week = getCurrentWeek();
  const day = WEEKDAYS[new Date().getDay()];
  return { week, day };
}

/* ========== MealPlan 読み出し ========== */
async function getTodayRows() {
  const { week, day } = getTodayKey();
  const { sheet } = await getSheet("MealPlan");
  const rows = await sheet.getRows();
  return rows.filter((r) => Number(r.Week) === week && String(r.Day) === day);
}
async function findMealSlot(slot) {
  const rows = await getTodayRows();
  return rows.find((r) => r.Kind === "Meal" && String(r.Slot) === slot) || null;
}
async function findTrainingToday() {
  const rows = await getTodayRows();
  return rows.find((r) => r.Kind === "Training") || null;
}
async function buildTodayPlanText() {
  const { week, day } = getTodayKey();
  const rows = await getTodayRows();
  if (!rows.length) return `今日のメニューは未設定です。（Week${week} ${day})`;

  const order = ["朝", "昼", "夜", "就寝"];
  const meals = rows.filter((r) => r.Kind === "Meal");
  const train = rows.find((r) => r.Kind === "Training");

  let total = { kcal: 0, p: 0, f: 0, c: 0 };
  const out = [`【今日のメニュー】(Week${week} ${day})`];

  for (const s of order) {
    const m = meals.find((r) => r.Slot === s);
    if (m) {
      out.push(
        "",
        `🍴 【${m.Slot}】\n${m.Text}\n${toNum(m.Calories)}kcal (P${toNum(m.P)}/F${toNum(m.F)}/C${toNum(m.C)})\nTips: ${m.Tips || "-"}`
      );
      total.kcal += toNum(m.Calories);
      total.p += toNum(m.P);
      total.f += toNum(m.F);
      total.c += toNum(m.C);
    }
  }
  out.push("", `=== 合計 ===\n${total.kcal} kcal (P${total.p}/F${total.f}/C${total.c})`);
  if (train) out.push("", `🏋️‍♂️ 【今日のトレーニング】\n${train.Text}\nTips: ${train.Tips || "-"}`);
  return out.join("\n");
}

/* ========== 来週メニュー自動生成（重複ガード） ========== */
async function generateNextWeekMenu() {
  const nextWeek = getCurrentWeek() + 1;

  const sys = "あなたは厳しめの日本語の栄養士兼トレーナー。減量向けの週次メニューを安全に生成する。";
  const user = `
対象: 28歳男性/170cm/80kg、リモートワーク、朝ジム。魚は刺身中心可、夜は低糖質。週で同メニューは最大3回まで。
CSVで出力（ヘッダ必須）: Day,Kind,Slot,Text,Calories,P,F,C,Tips
- Day: Sun,Mon,Tue,Wed,Thu,Fri,Sat
- Kind: "Meal" or "Training"
- Slot: Meal→朝/昼/夜/就寝, Training→ジム or 休養
- Calories/P/F/C は数値（Trainingは空で可）
説明・コードブロック不要。CSVのみで返答。
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
  const lines = csv.split("\n").map((s) => s.trim()).filter(Boolean);
  if (!/^Day,?Kind,?Slot,?Text,?Calories,?P,?F,?C,?Tips/i.test(lines[0])) {
    throw new Error("CSVヘッダが想定と異なります。モデル出力を確認してください。");
  }

  const { sheet } = await getSheet("MealPlan");
  const existing = await sheet.getRows();

  for (const line of lines.slice(1)) {
    const [Day, Kind, Slot, Text, Calories, P, F, C, Tips] = line.split(",");
    const exists = existing.find(
      (r) => Number(r.Week) === nextWeek && r.Day === (Day || "").trim() && r.Slot === (Slot || "").trim()
    );
    if (exists) continue;
    await sheet.addRow({
      Week: nextWeek,
      Day: (Day || "").trim(),
      Kind: (Kind || "").trim(),
      Slot: (Slot || "").trim(),
      Text: (Text || "").trim(),
      Calories: (Calories || "").trim(),
      P: (P || "").trim(),
      F: (F || "").trim(),
      C: (C || "").trim(),
      Tips: (Tips || "").trim(),
    });
  }
  return `来週(Week${nextWeek})のメニューを自動生成し保存しました。`;
}

/* ========== 月初アーカイブ（4週より古いデータ） ========== */
async function archiveOldWeeks() {
  const { doc, sheet } = await getSheet("MealPlan");
  const rows = await sheet.getRows();

  const current = getCurrentWeek();
  const cutoff = current - 4;
  if (cutoff <= 0) return;

  const old = rows.filter((r) => Number(r.Week) <= cutoff);
  if (!old.length) return;

  const now = new Date();
  const ym = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}`;
  let archive = doc.sheetsByTitle[`Archive_${ym}`];
  if (!archive) {
    archive = await doc.addSheet({ title: `Archive_${ym}`, headerValues: sheet.headerValues });
  }

  for (const r of old) {
    await archive.addRow(r._rawData);
    await r.delete();
  }
  console.log(`[Archive] moved <= Week${cutoff} to Archive_${ym}`);
}

/* ========== Push（スロット別） ========== */
async function pushSlot(slotName, fallback) {
  if (!LAST_USER_ID) return;
  try {
    if (slotName === "ジム前") {
      const tr = await findTrainingToday();
      if (tr) {
        const text = `【今日のトレーニング】\n${tr.Text}\nTips: ${tr.Tips || "-"}`;
        return client.pushMessage(LAST_USER_ID, { type: "text", text });
      }
      return client.pushMessage(LAST_USER_ID, { type: "text", text: fallback });
    }
    if (slotName === "ジム後") {
      const morning = await findMealSlot("朝");
      if (morning) {
        const text =
          `【ジム後】まずはプロテイン。その後の朝食：\n` +
          `${morning.Text}\n${toNum(morning.Calories)}kcal (P${toNum(morning.P)}/F${toNum(morning.F)}/C${toNum(morning.C)})\n` +
          `Tips: ${morning.Tips || "-"}`;
        return client.pushMessage(LAST_USER_ID, { type: "text", text });
      }
      return client.pushMessage(LAST_USER_ID, { type: "text", text: fallback });
    }
    const map = { 起床: "朝", 昼食: "昼", 夕食: "夜", 就寝前: "就寝", 間食: "間食" };
    const slot = map[slotName];
    if (slot) {
      const m = await findMealSlot(slot);
      if (m) {
        const text =
          `🍴 【${m.Slot}】\n${m.Text}\n${toNum(m.Calories)}kcal (P${toNum(m.P)}/F${toNum(m.F)}/C${toNum(m.C)})\n` +
          `Tips: ${m.Tips || "-"}`;
        return client.pushMessage(LAST_USER_ID, { type: "text", text });
      }
    }
    return client.pushMessage(LAST_USER_ID, { type: "text", text: fallback });
  } catch (e) {
    console.error(`[push ${slotName}] error`, e);
  }
}

/* ========== 確認系エンドポイント ========== */
app.get("/", (_req, res) => res.send("LINE Bot Server OK"));
app.get("/whoami", (_req, res) => res.json({ userIdSet: !!LAST_USER_ID, lastUserId: LAST_USER_ID }));
app.get("/push-test", async (_req, res) => {
  try {
    if (!LAST_USER_ID) return res.send("userId未取得：一度Botに話しかけてください。");
    await client.pushMessage(LAST_USER_ID, { type: "text", text: "【テストPush】起きろ。水500ml＋EAAだ。" });
    res.send("Push送信OK");
  } catch (e) {
    console.error("push-test error", e);
    res.status(500).send("Push送信失敗");
  }
});
app.get("/diag-sheets", async (_req, res) => {
  try {
    const doc = newDoc();
    await doc.loadInfo();
    const sheets = Object.values(doc.sheetsByTitle).map((s) => s.title);
    res.json({
      sheetId: process.env.GOOGLE_SHEET_ID,
      docTitle: doc.title,
      sheets,
      needMealPlan: !sheets.includes("MealPlan"),
      svcEmail: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON).client_email,
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

/* ========== LINE Webhook（※ express.json() は使わない） ========== */
app.post("/webhook", line.middleware(lineConfig), async (req, res) => {
  try {
    await Promise.all(
      (req.body.events || []).map(async (e) => {
        if (e?.source?.userId) LAST_USER_ID = e.source.userId;

        if (e.type === "message" && e.message?.type === "text") {
          const t = (e.message.text || "").trim();

          if (t.includes("今日のメニュー")) {
            const msg = await buildTodayPlanText();
            return client.replyMessage(e.replyToken, { type: "text", text: msg });
          }
          if (t.includes("来週メニュー生成")) {
            const msg = await generateNextWeekMenu();
            return client.replyMessage(e.replyToken, { type: "text", text: msg });
          }

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
      })
    );
    res.sendStatus(200);
  } catch (err) {
    console.error("Webhook error", err);
    res.sendStatus(500);
  }
});

/* ========== CRON（JST） ========== */
cron.schedule("50 5 * * *", () => pushSlot("起床", "【起床】水500ml＋EAA。朝食までに体を起こせ。"), { timezone: TZ });
cron.schedule("0 6 * * *", () => pushSlot("ジム前", "【ジム前】動的ストレッチ。関節を温めろ。"), { timezone: TZ });
cron.schedule("30 7 * * *", () => pushSlot("ジム後", "【ジム後】プロテイン摂れ。朝食は計画どおり。"), { timezone: TZ });
cron.schedule("0 12 * * *", () => pushSlot("昼食", "【昼食】予定どおり。食後20分歩け。"), { timezone: TZ });
cron.schedule("0 15 * * *", () => pushSlot("間食", "【間食】プロテイン＋素焼きナッツ一握り。ストレッチ2分。"), { timezone: TZ });
cron.schedule("0 19 * * *", () => pushSlot("夕食", "【夕食】計画どおり。糖質は控えめに。"), { timezone: TZ });
cron.schedule("0 23 * * *", () => pushSlot("就寝前", "【就寝前】ヨーグルト＋プロテイン。23時は電源OFF。"), { timezone: TZ });

// 週末（日曜20:00）: 来週メニュー自動生成
cron.schedule("0 20 * * 0", async () => {
  try {
    const msg = await generateNextWeekMenu();
    if (LAST_USER_ID) await client.pushMessage(LAST_USER_ID, { type: "text", text: msg });
  } catch (e) {
    console.error("[cron nextweek] error", e);
  }
}, { timezone: TZ });

// 月初（1日0:00）: アーカイブ
cron.schedule("0 0 1 * *", async () => {
  try {
    await archiveOldWeeks();
  } catch (e) {
    console.error("[cron archive] error", e);
  }
}, { timezone: TZ });

/* ========== 起動 ========== */
app.listen(process.env.PORT || 3000, () => console.log("Server OK"));
