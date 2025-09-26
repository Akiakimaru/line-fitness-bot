require("dotenv").config();
const express = require("express");
const line = require("@line/bot-sdk");
const OpenAI = require("openai");
const { google } = require("googleapis");
const fs = require("fs");
const path = require("path");

const app = express();

// ===== LINE SDK =====
const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};
const client = new line.Client(config);

// ===== OpenAI =====
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ===== ユーザーID保存 =====
const DATA_DIR = process.env.DATA_DIR || "/data";
const USER_FILE = path.join(DATA_DIR, "user.json");
fs.mkdirSync(DATA_DIR, { recursive: true });

function loadUserId() {
  try {
    if (!fs.existsSync(USER_FILE)) return null;
    return JSON.parse(fs.readFileSync(USER_FILE, "utf8")).lastUserId || null;
  } catch {
    return null;
  }
}
function saveUserId(id) {
  fs.writeFileSync(USER_FILE, JSON.stringify({ lastUserId: id }), "utf8");
}
let LAST_USER_ID = loadUserId();

// ===== Google Sheets =====
function getServiceAccountCreds() {
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    return JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  }
  if (process.env.GOOGLE_SERVICE_ACCOUNT_B64) {
    return JSON.parse(
      Buffer.from(process.env.GOOGLE_SERVICE_ACCOUNT_B64, "base64").toString("utf8")
    );
  }
  throw new Error("サービスアカウントJSONが設定されていません");
}
const creds = getServiceAccountCreds();
const auth = new google.auth.GoogleAuth({
  credentials: creds,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const sheets = google.sheets({ version: "v4", auth });
const SHEET_ID = process.env.GOOGLE_SHEETS_ID;
const LOGS_RANGE = "logs!A:M";

async function appendLogRow(row) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: LOGS_RANGE,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [row] },
  });
}

// ===== 確認用 =====
app.get("/", (_req, res) => res.send("LINE Bot Server OK"));
app.get("/whoami", (_req, res) =>
  res.json({ userIdSet: !!LAST_USER_ID, lastUserId: LAST_USER_ID })
);

// ===== Webhook =====
app.post("/webhook", line.middleware(config), async (req, res) => {
  try {
    await Promise.all((req.body.events || []).map(handleEvent));
    res.sendStatus(200);
  } catch (e) {
    console.error("Webhook error", e);
    res.sendStatus(500);
  }
});

// ===== 食事解析（テキスト入力用） =====
async function analyzeMealText(text, mealSlot) {
  const prompt = `
ユーザーの食事内容を解析し、カロリーとPFCを推定してください。
出力は必ずJSONのみで:
{
 "items_compact": "玄米150g, 鮭100g, サラダ",
 "kcal": 500,
 "p": 35,
 "f": 10,
 "c": 70,
 "verdict": "良好|脂質過多|炭水化物不足|野菜不足|過食|不足|その他",
 "tip_short": "改善の短いアドバイス"
}
発話: ${text}
`;

  const res = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.2,
    messages: [{ role: "user", content: prompt }],
  });

  let parsed = {};
  try {
    parsed = JSON.parse(res.choices[0].message.content);
  } catch {
    parsed = {};
  }

  const ts = new Date().toISOString();
  const row = [
    ts,
    "meal_in",
    mealSlot,
    parsed.kcal || "",
    parsed.p || "",
    parsed.f || "",
    parsed.c || "",
    parsed.items_compact || text,
    parsed.verdict || "不明",
    parsed.tip_short || "",
    "",
    "SHOK",
    "text",
  ];

  return { row, parsed };
}

// ===== イベント処理 =====
async function handleEvent(e) {
  if (!e || e.type !== "message") return;
  if (e.source?.userId) {
    LAST_USER_ID = e.source.userId;
    saveUserId(LAST_USER_ID);
  }

  // --- テキスト受信 ---
  if (e.message.type === "text") {
    const t = e.message.text.trim();

    // 食事入力（例：「朝食 玄米150g 鮭100g サラダ」）
    if (/^(朝食|昼食|夕食|間食)/.test(t)) {
      const mealSlot = t.split(" ")[0];
      const { row, parsed } = await analyzeMealText(t, mealSlot);
      await appendLogRow(row);

      const reply = `その内容で本当に痩せられると思っていますか？
- 内容：${parsed.items_compact || t}
- 指摘：${parsed.verdict || "不明"}
- Tips：${parsed.tip_short || "野菜追加・水分確保"}
目安: ${parsed.kcal || 0}kcal / P${parsed.p || 0} F${parsed.f || 0} C${parsed.c || 0}
—SHOK`;

      return client.replyMessage(e.replyToken, { type: "text", text: reply });
    }

    // 体重記録
    if (/^体重\s+(\d+(\.\d+)?)$/.test(t)) {
      const w = Number(t.split(/\s+/)[1]);
      await appendLogRow([
        new Date().toISOString(),
        "weight",
        "",
        "",
        "",
        "",
        "",
        `${w}kg`,
        "記録",
        "",
        "",
        "GEN",
        "text",
      ]);
      return client.replyMessage(e.replyToken, {
        type: "text",
        text: `体重 ${w}kg を記録しました。\n—GEN`,
      });
    }

    // トレーニング関連キーワード（例：「今日のジム」）
    if (t.includes("ジム")) {
      const reply = `甘えずに取り組んでください。
- スクワット：60kg × 10回 × 4セット
- ベンチプレス：50kg × 8回 × 4セット
- 腹筋サイクリング：30回 × 3セット
—KINIK`;
      return client.replyMessage(e.replyToken, { type: "text", text: reply });
    }

    // それ以外は汎用応答
    try {
      const res = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        temperature: 0.5,
        messages: [
          { role: "system", content: "あなたは厳しめだけど的確なコーチです。会話はですます調。" },
          { role: "user", content: t },
        ],
      });
      const reply = res.choices[0].message.content.trim();
      return client.replyMessage(e.replyToken, {
        type: "text",
        text: `${reply}\n—GEN`,
      });
    } catch (err) {
      console.error("free chat error", err);
      return client.replyMessage(e.replyToken, { type: "text", text: "処理に失敗しました。\n—GEN" });
    }
  }
}

// ===== サーバー起動 =====
app.listen(process.env.PORT || 3000, () => {
  console.log("Server OK");
});
