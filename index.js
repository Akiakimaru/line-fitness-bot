// ====== 基本設定 ======
require("dotenv").config();
const express = require("express");
const line = require("@line/bot-sdk");
const OpenAI = require("openai");
const cron = require("node-cron");
const fs = require("fs");
const path = require("path");
const { google } = require("googleapis");

const app = express(); // ※express.json() は使わない（LINE署名検証のため）

// ====== LINE SDK ======
const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};
const client = new line.Client(config);

// ====== OpenAI ======
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ====== userId 永続化（/data 推奨） ======
const DATA_DIR = process.env.DATA_DIR || "/data";
const USER_FILE = path.join(DATA_DIR, "user.json");
fs.mkdirSync(DATA_DIR, { recursive: true });

function loadUserId() {
  try {
    if (!fs.existsSync(USER_FILE)) return null;
    const raw = fs.readFileSync(USER_FILE, "utf8");
    return JSON.parse(raw)?.lastUserId || null;
  } catch { return null; }
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

// ====== Google Sheets（短縮保存スキーマ） ======
const sheetsAuth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || "{}"),
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const sheets = google.sheets({ version: "v4", auth: sheetsAuth });
const SHEET_ID = process.env.GOOGLE_SHEETS_ID;
const LOGS_RANGE = "logs!A:M"; // ts,type,meal_slot,kcal,p,f,c,items_compact,verdict,tip_short,context,role,source

async function appendLogRow(row) {
  if (!SHEET_ID) return;
  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: LOGS_RANGE,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [row] },
    });
  } catch (e) {
    console.error("[sheets] append error", e?.response?.data || e.message);
  }
}
function isoJst() {
  return new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Tokyo" })).toISOString();
}

// ====== 確認用 ======
app.get("/", (_req, res) => res.send("LINE Bot Server OK"));
app.get("/whoami", (_req, res) => res.json({ userIdSet: !!LAST_USER_ID, lastUserId: LAST_USER_ID || null }));
app.get("/push-test", async (_req, res) => {
  try {
    if (!LAST_USER_ID) return res.send("userId未取得：一度Botへメッセージしてください。");
    await client.pushMessage(LAST_USER_ID, { type: "text", text: "【テストPush】水500ml＋EAAを摂ってください。" });
    res.send("Push送信OK");
  } catch (e) {
    console.error("push-test error", e);
    res.status(500).send("Push送信失敗");
  }
});

// ====== Webhook（署名検証） ======
app.post("/webhook", line.middleware(config), async (req, res) => {
  try {
    await Promise.all((req.body.events || []).map(handleEvent));
    res.sendStatus(200);
  } catch (e) {
    console.error("Webhook error", e);
    res.sendStatus(500);
  }
});

// ====== プロンプト：ベース＋人格 ======
const BASE_TONE = `
会話は必ず日本語の「です・ます調」。甘やかさず端的に答えます。
最初の1文は鋭く指摘してください（例：「その選択で本当に痩せられると思っていますか？」）。
食事やトレーニングの具体指示はマークダウンの箇条書きで、可能な限り g/切れ数/回数/セット/テンポを明記します。
医学的断定は避け、安全最優先で助言してください。
`;

const SHOK_PROMPT = `
あなたは「栄養管理士（SHOK）」として応答します。
- 魚は刺身中心、肉で補完。パプリカ・ピーマンは避ける。オートミールは食べやすい方法も提案。
- たんぱく質は日量150〜160g目安。水分と食後有酸素（20分歩行など）を推奨。
- 食事の提案/評価を出すときは、最後に必ず「目安: xxxkcal / Pxx Fxx Cxx」を1行で付けてください（推定で可）。
- 買い物・下処理・外食代替も具体的に。
— SHOK
`;

const KINIK_PROMPT = `
あなたは「パーソナルトレーナー（KINIK）」として応答します。
- 朝ジム前提。Push/Pull/Legsローテとコンディションに応じた調整を具体的に。
- 可動域（フルROM/部分ROM）、テンポ（例: 3-1-1）、休憩秒数、代替種目を明記。
— KINIK
`;

const GEN_PROMPT = `
あなたは汎用コーチとして、動機づけや方針整理を短く行います。必要ならSHOKやKINIKへ誘導します。
`;

// ====== ルーティング（SHOK/KINIK/GEN を判定） ======
async function routeRole(userText) {
  const routerPrompt = `
ユーザー発話の意図を判定して "role" を返してください。
- 食事・栄養・買い物・献立・外食相談 → role="SHOK"
- トレーニング・フォーム・メニュー・疲労管理 → role="KINIK"
- どちらでもない一般相談 → role="GEN"
出力はJSONのみ：{"role":"SHOK|KINIK|GEN"}
発話: ${userText}
`;
  const res = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0,
    messages: [{ role: "user", content: routerPrompt }],
  });
  const text = res.choices?.[0]?.message?.content || "";
  try {
    const obj = JSON.parse(text);
    if (obj && (obj.role === "SHOK" || obj.role === "KINIK" || obj.role === "GEN")) return obj.role;
  } catch {}
  return "GEN";
}

// ====== 会話（人格別） ======
async function replyByRole(role, userText) {
  let system = BASE_TONE;
  if (role === "SHOK") system += SHOK_PROMPT;
  else if (role === "KINIK") system += KINIK_PROMPT;
  else system += GEN_PROMPT;

  // SHOKは食事系でPFC/kcal必須化
  const userWrapped =
    role === "SHOK"
      ? `次の発言に栄養管理士（SHOK）として応答してください。
会話はですます調、冒頭に鋭い一言。
箇条書きの後、最後に必ず「目安: xxxkcal / Pxx Fxx Cxx」を1行で付ける（推定で可）。
発言: ${userText}`
      : userText;

  const res = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.3,
    max_tokens: 450,
    messages: [
      { role: "system", content: system },
      { role: "user", content: userWrapped },
    ],
  });
  const out = res.choices?.[0]?.message?.content?.trim() || "要点を短くお願いします。";
  return out;
}

// ====== 画像処理（テキスト化保存：items/評価/PFC） ======
async function fetchImageAsDataUrl(messageId) {
  const stream = await client.getMessageContent(messageId);
  const chunks = [];
  for await (const c of stream) chunks.push(c);
  const buf = Buffer.concat(chunks);
  // 簡易MIME判定（jpeg/png）
  const isPng = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  const mime = isPng ? "image/png" : "image/jpeg";
  return `data:${mime};base64,${buf.toString("base64")}`;
}

async function analyzeMealImageToCompactRow(dataUrl, mealSlot = "") {
  // SHOKで評価＋PFC推定＆短縮保存用パース
  const prompt = `
この食事写真を厳しめに評価し、短縮保存できる指標を出してください。
出力はJSONのみ：
{
 "items_compact": "玄米150g, 刺身100g, サラダ100g",
 "verdict": "良好|脂質過多|炭水化物不足|野菜不足|過食|不足|その他",
 "tip_short": "赤身中心/食後20分歩く",
 "kcal": 520,
 "p": 35, "f": 14, "c": 65
}
※ 推定で構いません。
`;
  const res = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.2,
    messages: [
      { role: "system", content: BASE_TONE + SHOK_PROMPT },
      { role: "user", content: [
        { type: "text", text: prompt },
        { type: "image_url", image_url: { url: dataUrl } },
      ]},
    ],
  });
  const text = res.choices?.[0]?.message?.content || "{}";
  let parsed = {};
  try { parsed = JSON.parse(text); } catch {}
  const ts = isoJst();
  const row = [
    ts, "meal_fb", mealSlot || "",                        // ts,type,meal_slot
    Number(parsed.kcal||0), Number(parsed.p||0), Number(parsed.f||0), Number(parsed.c||0), // kcal,p,f,c
    parsed.items_compact || "", parsed.verdict || "", parsed.tip_short || "",              // items,verdict,tip
    "", "SHOK", "image"                                                                       // context,role,source
  ];
  // ユーザーへの返答文（厳しめ＋PFC）
  const reply = `その内容で本当に痩せられると思っていますか？選び方と量を整えます。
- 内容：${row[7] || "推定不可"}
- 指摘：${row[8] || "不明"}
- Tips：${row[9] || "野菜追加・水分確保"}
目安: ${row[3]||0}kcal / P${row[4]||0} F${row[5]||0} C${row[6]||0}
— SHOK`;
  return { row, reply };
}

// ====== イベント処理 ======
async function handleEvent(e) {
  if (!e || e.type !== "message") return;

  // userId更新・保存
  if (e.source?.userId && e.source.userId !== LAST_USER_ID) {
    LAST_USER_ID = e.source.userId;
    saveUserId(LAST_USER_ID);
  }

  // 画像
  if (e.message.type === "image") {
    await client.replyMessage(e.replyToken, { type: "text", text: "受け取りました。確認中です。" });
    (async () => {
      try {
        const dataUrl = await fetchImageAsDataUrl(e.message.id);
        const { row, reply } = await analyzeMealImageToCompactRow(dataUrl, "");
        await appendLogRow(row); // 画像は保存せず、テキストのみ保存
        if (LAST_USER_ID) await client.pushMessage(LAST_USER_ID, { type: "text", text: reply });
      } catch (err) {
        console.error("Image error", err);
        if (LAST_USER_ID) await client.pushMessage(LAST_USER_ID, { type: "text", text: "写真解析に失敗しました。全体が映る明るい写真で送り直してください。" });
      }
    })();
    return;
  }

  // テキスト
  if (e.message.type === "text") {
    const t = (e.message.text || "").trim();

    // 体重ログ（例：「体重 72.4」）
    if (/^体重\s+(\d+(\.\d+)?)$/.test(t)) {
      const w = Number(t.split(/\s+/)[1]);
      const ts = isoJst();
      await appendLogRow([
        ts, "weight", "", "", "", "", "", `${w}kg`, "記録", "継続", "home", "GEN", "text"
      ]);
      return client.replyMessage(e.replyToken, { type: "text", text: `体重 ${w}kg を記録しました。継続しましょう。` });
    }

    // ルーティング → 人格別応答
    try {
      const role = await routeRole(t);
      const reply = await replyByRole(role, t);
      return client.replyMessage(e.replyToken, { type: "text", text: reply });
    } catch (err) {
      console.error("free chat error", err);
      return client.replyMessage(e.replyToken, { type: "text", text: "処理に失敗しました。短く要点だけでもう一度お願いします。" });
    }
  }
}

// ====== 定時リマインド（JST） ======
const TZ = "Asia/Tokyo";
const schedules = [
  { cron: "50 5 * * *", text: "【起床】水500ml＋EAAを摂ってください。" },
  { cron: "5 6 * * *",  text: "【ジム前】動的ストレッチをしてください。" },
  { cron: "20 7 * * *", text: "【ジム後】プロテインと朝食をとってください。" },
  { cron: "0 12 * * *", text: "【昼食】玄米150g＋刺身100〜150gを意識してください。" },
  { cron: "0 15 * * *", text: "【間食】ナッツを食べて軽いストレッチをしてください。" },
  { cron: "0 20 * * *", text: "【夕食】鶏むね120g＋豆腐＋サラダをとってください。" },
  { cron: "30 22 * * *", text: "【就寝前】ヨーグルト＋プロテイン、23時にはデバイス電源OFFにしてください。" },
];
for (const s of schedules) {
  cron.schedule(s.cron, async () => {
    console.log("[cron fired]", s.text);
    if (!LAST_USER_ID) return console.log("[cron] skipped: userId missing");
    try { await client.pushMessage(LAST_USER_ID, { type: "text", text: s.text }); }
    catch (err) { console.error("cron push error", err); }
  }, { timezone: TZ });
}

// ====== 週次レビュー（簡易） ======
// ※ 後で "weekly_snapshot" 生成に差し替え可
cron.schedule("0 21 * * 0", async () => {
  console.log("[cron fired] 週次レビュー");
  if (!LAST_USER_ID || !SHEET_ID) return;
  try {
    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID, range: LOGS_RANGE
    });
    const rows = (resp.data.values || []).slice(1);
    const since = Date.now() - 7*24*60*60*1000;
    const recent = rows.filter(r => Date.parse(r[0]||"") >= since);

    const weights = recent.filter(r=>r[1]==="weight").map(r => {
      const m = String(r[7]||"").match(/([\d.]+)/);
      return m ? Number(m[1]) : NaN;
    }).filter(n=>!isNaN(n));
    const fbCount = recent.filter(r=>r[1]==="meal_fb").length;

    const avgW = weights.length ? (weights.reduce((a,b)=>a+b,0)/weights.length).toFixed(1) : "-";
    const trend = weights.length ? `${weights[0]}→${weights[weights.length-1]}` : "-";

    await client.pushMessage(LAST_USER_ID, {
      type: "text",
      text: `【週次レビュー(簡易)】\n計測:${weights.length} 平均体重:${avgW} 推移:${trend}\n食事FB:${fbCount}件\n来週は食事の質と就寝時刻をもう一段整えましょう。`
    });
  } catch (err) {
    console.error("weekly review error", err);
  }
}, { timezone: TZ });

// ====== 起動 ======
app.listen(process.env.PORT || 3000, () => {
  console.log("Server OK");
});
