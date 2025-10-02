// ==============================
// index.js  — 完成版
// ==============================
require("dotenv").config();
const express = require("express");
const line = require("@line/bot-sdk");
const OpenAI = require("openai");
const cron = require("node-cron");
const { GoogleSpreadsheet } = require("google-spreadsheet");
const fs = require("fs");
const path = require("path");

const app = express();
// LINE署名検証のため、独自bodyParserは使わない
app.use(express.json());

// ------------------------------
// 環境変数
// ------------------------------
const {
  LINE_CHANNEL_ACCESS_TOKEN,
  LINE_CHANNEL_SECRET,
  OPENAI_API_KEY,
  GOOGLE_SHEET_ID, // 例: https://docs.google.com/spreadsheets/d/<これ>/edit の <これ>
  GOOGLE_SERVICE_ACCOUNT_JSON, // 生JSON
  GOOGLE_SERVICE_ACCOUNT_B64,  // Base64（JSONの代替）
  DATA_DIR = "/data",
  PORT = 3000,
} = process.env;

// ------------------------------
// LINE 初期化
// ------------------------------
const lineConfig = {
  channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: LINE_CHANNEL_SECRET,
};
const client = new line.Client(lineConfig);

// ------------------------------
// OpenAI 初期化
// ------------------------------
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// ------------------------------
// ユーザーIDの永続化
// ------------------------------
fs.mkdirSync(DATA_DIR, { recursive: true });
const USER_FILE = path.join(DATA_DIR, "user.json");

function loadUserId() {
  try {
    if (!fs.existsSync(USER_FILE)) return null;
    const raw = fs.readFileSync(USER_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return parsed?.lastUserId || null;
  } catch (e) {
    console.error("[userStore] load error", e);
    return null;
  }
}
function saveUserId(id) {
  try {
    fs.writeFileSync(
      USER_FILE,
      JSON.stringify({ lastUserId: id, updatedAt: new Date().toISOString() }),
      "utf8"
    );
  } catch (e) {
    console.error("[userStore] save error", e);
  }
}
let LAST_USER_ID = loadUserId();
console.log("[userStore] loaded:", LAST_USER_ID ? "exists" : "none");

// ------------------------------
// Google Sheets 初期化
// ------------------------------
function getServiceAccountJSON() {
  if (GOOGLE_SERVICE_ACCOUNT_JSON && GOOGLE_SERVICE_ACCOUNT_JSON.trim().startsWith("{")) {
    return JSON.parse(GOOGLE_SERVICE_ACCOUNT_JSON);
  }
  if (GOOGLE_SERVICE_ACCOUNT_B64) {
    const decoded = Buffer.from(GOOGLE_SERVICE_ACCOUNT_B64, "base64").toString("utf8");
    return JSON.parse(decoded);
  }
  throw new Error("サービスアカウント鍵が未設定です（GOOGLE_SERVICE_ACCOUNT_JSON か GOOGLE_SERVICE_ACCOUNT_B64）");
}

const doc = new GoogleSpreadsheet(GOOGLE_SHEET_ID);
async function initSheet(sheetName) {
  const creds = getServiceAccountJSON();
  await doc.useServiceAccountAuth(creds);
  await doc.loadInfo();
  const sheet = doc.sheetsByTitle[sheetName];
  if (!sheet) throw new Error(`シート '${sheetName}' が見つかりません`);
  return sheet;
}

// meals: slot,text,kcal,p,f,c,tips
// reminders: week_start,slot,text,approved,created_at
// logs: 任意（今回は使わないが将来拡張用）

// ------------------------------
// 共通ユーティリティ
// ------------------------------
function todayISO() {
  return new Date().toISOString().split("T")[0];
}
function jstNowISO() {
  return new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Tokyo" })).toISOString();
}
function nextMondayISO() {
  const d = new Date();
  d.setDate(d.getDate() + ((1 + 7 - d.getDay()) % 7));
  return d.toISOString().split("T")[0];
}

// ------------------------------
// meals シートから該当スロットを取得
// ------------------------------
async function getMeal(slot) {
  const sheet = await initSheet("meals");
  const rows = await sheet.getRows();
  // 完全一致（「朝」「昼」「夜」「ジム」「就寝」「週メニュー」）
  const row = rows.find((r) => (r.slot || "").trim() === slot);
  if (!row) return null;
  return {
    slot: row.slot,
    text: row.text,
    kcal: row.kcal,
    p: row.p,
    f: row.f,
    c: row.c,
    tips: row.tips,
  };
}

// ------------------------------
// 表示フォーマット（役割ラベル付）
// ------------------------------
function formatMealMessage(meal) {
  if (!meal) {
    return { type: "text", text: "対象のメニューが見つかりませんでした。\n—GEN" };
  }
  // 役割判定：ジム or 週メニュー は KINIK、それ以外は SHOK
  const isKINIK = meal.slot.includes("ジム") || meal.slot.includes("週");
  const role = isKINIK ? "KINIK" : "SHOK";

  // 数値でない場合はそのまま表示（ジムの消費kcalなど）
  const kcal = (meal.kcal === undefined || meal.kcal === null || meal.kcal === "" || meal.kcal === "-")
    ? `${meal.kcal || "-"}`
    : `${meal.kcal}kcal`;

  const p = meal.p ?? "-";
  const f = meal.f ?? "-";
  const c = meal.c ?? "-";

  return {
    type: "text",
    text:
`【${meal.slot}】
${meal.text}

カロリー: ${kcal}
P: ${p}g / F: ${f}g / C: ${c}g

Tips: ${meal.tips}
—${role}`,
  };
}

// ------------------------------
// 週次：次週リマインド案の生成／修正
// ------------------------------
let STATE = "NORMAL";           // NORMAL / WAITING_APPROVAL
let TEMP_REMINDERS = [];        // { week, slot, text }

async function generateWeeklyRemindersFromAI() {
  // 将来的には logs を読み込んで傾向反映。まずはプロンプトのみで。
  const sys =
    "あなたは厳しめの日本語パーソナルトレーナーです。短く端的に、命令形で書いてください。";
  const user =
    "次週用の1日7回のリマインドを、起床/ジム前/ジム後/昼食/間食/夕食/就寝前 の順で、それぞれ1行で出してください。装飾なしのテキストのみ。";

  const res = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.3,
    messages: [
      { role: "system", content: sys },
      { role: "user", content: user },
    ],
  });

  const lines = (res.choices?.[0]?.message?.content || "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

  const slots = ["起床", "ジム前", "ジム後", "昼食", "間食", "夕食", "就寝前"];
  const week = nextMondayISO();
  return slots.map((slot, i) => ({
    week,
    slot,
    text: lines[i] || `${slot}の指示を守れ。`,
  }));
}

async function reviseRemindersFromAI(reminders) {
  const sys = "あなたは厳しめの日本語パーソナルトレーナーです。命令形で短く。";
  const user = "以下の7行の文面を、重複を避けつつ言い換えて提示してください：\n" +
    reminders.map((r) => `${r.slot}: ${r.text}`).join("\n");

  const res = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.5,
    messages: [
      { role: "system", content: sys },
      { role: "user", content: user },
    ],
  });

  const lines = (res.choices?.[0]?.message?.content || "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

  return reminders.map((r, i) => ({
    ...r,
    text: lines[i] || r.text,
  }));
}

// ------------------------------
// 承認フローで reminders に保存
// ------------------------------
async function saveReminders(reminders) {
  const sheet = await initSheet("reminders");
  for (const r of reminders) {
    await sheet.addRow({
      week_start: r.week,
      slot: r.slot,
      text: r.text,
      approved: true,
      created_at: jstNowISO(),
    });
  }
}

// ------------------------------
// Push時に reminders から文面取得
// ------------------------------
async function getLatestApprovedReminder(slot) {
  const sheet = await initSheet("reminders");
  const rows = await sheet.getRows();
  const filtered = rows.filter((r) => (r.slot || "") === slot && String(r.approved).toLowerCase() === "true");
  if (filtered.length === 0) return null;
  // 週の新しい順で最後を採用（created_at or week_start）
  filtered.sort((a, b) => {
    const ax = a.week_start || a.created_at || "";
    const bx = b.week_start || b.created_at || "";
    return ax.localeCompare(bx);
  });
  return filtered[filtered.length - 1]?.text || null;
}

// ------------------------------
// ルーティング：Webhook
// ------------------------------
app.post("/webhook", line.middleware(lineConfig), async (req, res) => {
  try {
    await Promise.all((req.body.events || []).map(handleEvent));
    res.sendStatus(200);
  } catch (e) {
    console.error("Webhook error", e);
    res.sendStatus(500);
  }
});

// ------------------------------
// イベント処理
// ------------------------------
async function handleEvent(e) {
  if (e.type !== "message" || e.message.type !== "text") return;
  const t = (e.message.text || "").trim();

  // userIdバインド
  if (e.source?.userId && e.source.userId !== LAST_USER_ID) {
    LAST_USER_ID = e.source.userId;
    saveUserId(LAST_USER_ID);
  }

  // --- 承認フェーズ（WAITING_APPROVAL） ---
  if (STATE === "WAITING_APPROVAL") {
    if (t.includes("承認")) {
      await saveReminders(TEMP_REMINDERS);
      TEMP_REMINDERS = [];
      STATE = "NORMAL";
      return client.replyMessage(e.replyToken, {
        type: "text",
        text: "承認しました。次週のPushに反映します。\n—GEN",
      });
    }
    if (t.includes("修正")) {
      const revised = await reviseRemindersFromAI(TEMP_REMINDERS);
      TEMP_REMINDERS = revised;
      return client.replyMessage(e.replyToken, {
        type: "text",
        text:
`修正案です。どちらにしますか？
${revised.map((r) => `${r.slot}: ${r.text}`).join("\n")}

「承認」または「修正」と送ってください。\n—GEN`,
      });
    }
    // それ以外は促し
    return client.replyMessage(e.replyToken, {
      type: "text",
      text: "「承認」または「修正」と送ってください。\n—GEN",
    });
  }

  // --- 強化版 Quick Reply：メニュー表示 ---
  if (t.includes("今日の朝")) {
    const meal = await getMeal("朝");
    return client.replyMessage(e.replyToken, formatMealMessage(meal));
  }
  if (t.includes("今日の昼")) {
    const meal = await getMeal("昼");
    return client.replyMessage(e.replyToken, formatMealMessage(meal));
  }
  if (t.includes("今日の夜")) {
    const meal = await getMeal("夜");
    return client.replyMessage(e.replyToken, formatMealMessage(meal));
  }
  if (t.includes("今日のジム")) {
    const meal = await getMeal("ジム");
    return client.replyMessage(e.replyToken, formatMealMessage(meal));
  }
  if (t.includes("就寝前")) {
    const meal = await getMeal("就寝");
    return client.replyMessage(e.replyToken, formatMealMessage(meal));
  }
  if (t.includes("今週メニュー")) {
    const meal = await getMeal("週メニュー");
    return client.replyMessage(e.replyToken, formatMealMessage(meal));
  }

  // --- 体重ログ（任意） ---
  if (/^体重\s+(\d+(\.\d+)?)$/.test(t)) {
    // 必要なら logs シートに保存する実装を追加可
    const w = Number(t.split(/\s+/)[1]);
    return client.replyMessage(e.replyToken, {
      type: "text",
      text: `体重 ${w}kg を記録しました。継続しましょう。\n—GEN`,
    });
  }

  // --- Quick Reply メニューを提示（通常時のデフォルト） ---
  const quick = {
    type: "text",
    text: "どれを確認しますか？",
    quickReply: {
      items: [
        { type: "action", action: { type: "message", label: "今日の朝", text: "今日の朝" } },
        { type: "action", action: { type: "message", label: "今日の昼", text: "今日の昼" } },
        { type: "action", action: { type: "message", label: "今日の夜", text: "今日の夜" } },
        { type: "action", action: { type: "message", label: "今日のジム", text: "今日のジム" } },
        { type: "action", action: { type: "message", label: "就寝前", text: "就寝前" } },
        { type: "action", action: { type: "message", label: "今週メニュー", text: "今週メニュー" } },
      ],
    },
  };
  return client.replyMessage(e.replyToken, quick);
}

// ------------------------------
// 週次：日曜23:00に次週案を自動生成→承認依頼
// ------------------------------
cron.schedule("0 23 * * 0", async () => {
  try {
    console.log("[cron] weekly proposal");
    const reminders = await generateWeeklyRemindersFromAI();
    TEMP_REMINDERS = reminders;
    STATE = "WAITING_APPROVAL";
    if (LAST_USER_ID && reminders.length > 0) {
      await client.pushMessage(LAST_USER_ID, {
        type: "text",
        text:
`【次週リマインド案】
${reminders.map((r) => `${r.slot}: ${r.text}`).join("\n")}

承認しますか？修正しますか？\n—GEN`,
      });
    } else {
      console.log("[cron] no userId or empty reminders");
    }
  } catch (e) {
    console.error("[cron weekly] error", e);
  }
}, { timezone: "Asia/Tokyo" });

// ------------------------------
// 毎日7回：reminders からPullしてPush
// ------------------------------
async function pushFromReminders(slot) {
  try {
    if (!LAST_USER_ID) return;
    const text = await getLatestApprovedReminder(slot);
    if (!text) return;
    await client.pushMessage(LAST_USER_ID, { type: "text", text });
  } catch (e) {
    console.error(`[cron push ${slot}] error`, e);
  }
}

cron.schedule("50 5 * * *", () => pushFromReminders("起床"),    { timezone: "Asia/Tokyo" });
cron.schedule("0 6 * * *",  () => pushFromReminders("ジム前"),  { timezone: "Asia/Tokyo" });
cron.schedule("30 7 * * *", () => pushFromReminders("ジム後"),  { timezone: "Asia/Tokyo" });
cron.schedule("0 12 * * *", () => pushFromReminders("昼食"),    { timezone: "Asia/Tokyo" });
cron.schedule("0 15 * * *", () => pushFromReminders("間食"),    { timezone: "Asia/Tokyo" });
cron.schedule("0 19 * * *", () => pushFromReminders("夕食"),    { timezone: "Asia/Tokyo" });
cron.schedule("0 23 * * *", () => pushFromReminders("就寝前"),  { timezone: "Asia/Tokyo" });

// ------------------------------
// 確認用エンドポイント
// ------------------------------
app.get("/", (_req, res) => res.send("LINE Bot Server OK"));
app.get("/whoami", (_req, res) => res.json({ userIdSet: !!LAST_USER_ID, lastUserId: LAST_USER_ID }));
app.get("/push-test", async (_req, res) => {
  try {
    if (!LAST_USER_ID) return res.send("userId未取得：一度Botにメッセージしてください。");
    await client.pushMessage(LAST_USER_ID, { type: "text", text: "【テストPush】動け。水500ml＋EAAだ。\n—KINIK" });
    res.send("Push送信OK");
  } catch (e) {
    console.error("push-test error", e);
    res.status(500).send("Push送信失敗");
  }
});
app.get("/admin/clear-user", (_req, res) => {
  try {
    if (fs.existsSync(USER_FILE)) fs.unlinkSync(USER_FILE);
    LAST_USER_ID = null;
    res.send("user.json を削除しました。LINEで一度話しかけて再バインドしてください。");
  } catch (e) {
    res.status(500).send("削除に失敗: " + e.message);
  }
});

// ------------------------------
// 起動
// ------------------------------
app.listen(PORT, () => {
  console.log("Server OK on port", PORT);
});
