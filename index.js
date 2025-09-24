// ====== 基本設定 ======
require("dotenv").config();
const express = require("express");
const line = require("@line/bot-sdk");
const OpenAI = require("openai");
const cron = require("node-cron");
const fs = require("fs");
const path = require("path");

const app = express(); // ← ※ express.json() は使わない（LINE署名検証のため）

// ====== LINE SDK ======
const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};
const client = new line.Client(config);

// ====== OpenAI ======
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ====== userId 永続化（JSON） ======
const DATA_DIR = process.env.DATA_DIR || "/data";       // RenderのDiskを /data でマウント想定
const USER_FILE = path.join(DATA_DIR, "user.json");

// ディレクトリ作成（なければ）
function ensureDir(p) {
  try { fs.mkdirSync(p, { recursive: true }); } catch {}
}
ensureDir(DATA_DIR);

function loadUserId() {
  try {
    if (!fs.existsSync(USER_FILE)) return null;
    const raw = fs.readFileSync(USER_FILE, "utf8");
    const obj = JSON.parse(raw);
    return obj?.lastUserId || null;
  } catch (e) {
    console.error("[userStore] load error", e);
    return null;
  }
}

function saveUserId(id) {
  try {
    const payload = JSON.stringify({ lastUserId: id, updatedAt: new Date().toISOString() });
    fs.writeFileSync(USER_FILE, payload, "utf8");
  } catch (e) {
    console.error("[userStore] save error", e);
  }
}

// メモリ上のキャッシュ + 起動時に読込
let LAST_USER_ID = loadUserId();
console.log("[userStore] loaded userId:", LAST_USER_ID ? "exists" : "none");

// ====== 確認用エンドポイント ======
app.get("/", (_req, res) => res.send("LINE Bot Server OK"));
app.get("/whoami", (_req, res) =>
  res.json({ userIdSet: !!LAST_USER_ID, lastUserId: LAST_USER_ID || null })
);
app.get("/push-test", async (_req, res) => {
  try {
    if (!LAST_USER_ID) return res.status(400).send("userId未取得：一度LINEでボットにメッセージを送ってください。");
    await client.pushMessage(LAST_USER_ID, { type: "text", text: "【テストPush】起きろ。水500ml＋EAAだ。" });
    res.send("Push送信OK");
  } catch (e) {
    console.error("push-test error", e);
    res.status(500).send("Push送信失敗");
  }
});

// ====== Webhook（LINEミドルウェア必須） ======
app.post("/webhook", line.middleware(config), async (req, res) => {
  try {
    await Promise.all((req.body.events || []).map(handleEvent));
    res.sendStatus(200);
  } catch (e) {
    console.error("Webhook error", e);
    res.sendStatus(500);
  }
});

// ====== イベント処理 ======
async function handleEvent(e) {
  if (!e || e.type !== "message") return;

  // userId 更新＆保存
  if (e.source?.userId && e.source.userId !== LAST_USER_ID) {
    LAST_USER_ID = e.source.userId;
    saveUserId(LAST_USER_ID);
    console.log("[userStore] saved userId");
  }

  // 画像：先に「処理中」を返し、完了後はPushで最終FB
  if (e.message.type === "image") {
    await client.replyMessage(e.replyToken, { type: "text", text: "受け取った。処理中。待て。" });

    (async () => {
      try {
        const dataUrl = await fetchImageAsDataUrl(e.message.id);
        const fb = await feedbackFromImage(dataUrl);
        if (LAST_USER_ID) {
          await client.pushMessage(LAST_USER_ID, { type: "text", text: `【最終FB】\n${fb}` });
        }
      } catch (err) {
        console.error("Image error", err);
        if (LAST_USER_ID) {
          await client.pushMessage(LAST_USER_ID, { type: "text", text: "処理失敗。全体が映る明るい写真で再提出。" });
        }
      }
    })();
    return;
  }

  // テキスト：コマンド分岐
  if (e.message.type === "text") {
    const t = (e.message.text || "").trim();

    if (t.includes("今日の朝")) {
      return client.replyMessage(e.replyToken, { type: "text", text: "【朝】オートミール30g＋卵＋鶏むね50g。写真を送れ。" });
    }
    if (t.includes("今日の昼")) {
      return client.replyMessage(e.replyToken, { type: "text", text: "【昼】玄米150g＋刺身100〜150g（8〜12切れ）。食後20分歩け。" });
    }
    if (t.includes("今日の夜")) {
      return client.replyMessage(e.replyToken, { type: "text", text: "【夜】鶏むね120g＋豆腐＋サラダ。ゆっくり噛め。" });
    }
    if (t.includes("今日のジム")) {
      return client.replyMessage(e.replyToken, { type: "text", text: gymPlanByDay(new Date().getDay()) });
    }
    if (t.includes("就寝前")) {
      return client.replyMessage(e.replyToken, { type: "text", text: "【就寝前】ヨーグルト＋プロテイン。明朝の準備を玄関に。23時電源OFF。" });
    }
    if (t.includes("今週メニュー")) {
      return client.replyMessage(e.replyToken, { type: "text", text: "【週メニュー】月Push/火Pull/水Legs/木軽Push/金Pull/土全身/日休養。" });
    }
    if (/^体重\s+(\d+(\.\d+)?)$/.test(t)) {
      const w = Number(t.split(/\s+/)[1]);
      return client.replyMessage(e.replyToken, { type: "text", text: `受理：体重 ${w}kg。明日も報告。` });
    }

    // デフォルト：クイックリプライ
    const quick = {
      type: "text",
      text: "写真を送れ。今すぐ動け。",
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
}

// ====== 画像→DataURL ======
async function fetchImageAsDataUrl(messageId) {
  const stream = await client.getMessageContent(messageId);
  const chunks = [];
  for await (const c of stream) chunks.push(c);
  const buf = Buffer.concat(chunks);
  // 簡易判定（jpeg/png）
  const isPng = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  const mime = isPng ? "image/png" : "image/jpeg";
  return `data:${mime};base64,${buf.toString("base64")}`;
}

// ====== OpenAIで画像FB ======
async function feedbackFromImage(dataUrl) {
  const prompt =
`料理・飲み物・スイーツ含め、どんな写真でも評価せよ。減量中（P150-160/日）。
出力：
1) 量の妥当性
2) ざっくりPFC推定
3) 改善提案（刺身/鶏むね/玄米等で置換）
4) 次回の盛付け指示（gや切れ数）
厳しめ日本語で2〜4行。`;

  const res = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.3,
    messages: [{
      role: "user",
      content: [
        { type: "text", text: prompt },
        { type: "image_url", image_url: { url: dataUrl } },
      ]
    }],
  });

  const out = res.choices?.[0]?.message?.content?.trim() || "情報不足。全体が映る写真で再提出。";
  return out.split("\n").filter(Boolean).slice(0, 4).join("\n");
}

// ====== ジムメニュー（例） ======
function gymPlanByDay(day) {
  switch (day) {
    case 1: return "【Push】ベンチ5×10/インクラインDB3×10/ショルダー3×10/サイド3×12/プレスダウン3×12";
    case 2: return "【Pull】デッド4×10/ラット4×10/ロー3×10/カール3×12/腹バイシクル3×30";
    case 3: return "【Legs】スクワット5×10/スプリット3×10/レッグカール3×12/エクステ3×12/腹バイ3×30";
    case 4: return "【Push軽】ベンチ4×10(軽)/インクラインDB3×12/ショルダー3×10/サイド3×15/キックバック3×12";
    case 5: return "【Pull】デッド4×8/ラット4×10/シーテッドロー3×10/EZカール3×12/腹バイ3×30";
    case 6: return "【Full+有酸素】ベンチ3×10/スクワット3×10/ラット3×10/ショルダー3×10/バイク30-40分";
    case 0: default: return "【休養】ストレッチ＆散歩30分。栄養と睡眠を優先。";
  }
}

// ====== 定時リマインド（JST） ======
const TZ = "Asia/Tokyo";
const schedules = [
  { cron: "50 5 * * *", text: "【起床】水500ml＋EAA。着替えたら出発。言い訳するな。" },
  { cron: "5 6 * * *",  text: "【ジム前】動的ストレッチ→本日のメニュー。可動域とテンポを守れ。" },
  { cron: "20 7 * * *", text: "【ジム後】プロテイン→朝食ルーティン。写真を送れ。" },
  { cron: "0 12 * * *", text: "【昼】玄米150g＋刺身100〜150g（8〜12切れ）。食後20分歩け。" },
  { cron: "0 15 * * *", text: "【補食】プロテイン＋ナッツ10粒。軽ストレッチ。" },
  { cron: "0 20 * * *", text: "【夕食】鶏むね120g＋豆腐＋サラダ。水分チェック。" },
  { cron: "30 22 * * *", text: "【就寝前】ヨーグルト＋プロテイン。明朝準備。23:00電源OFF。" },
];

// 検証用：毎分送信を有効にしたい場合は下をコメント解除
// cron.schedule("* * * * *", async () => {
//   console.log("[cron fired] テスト用");
//   if (!LAST_USER_ID) return console.log("[cron] skipped: userId missing");
//   try { await client.pushMessage(LAST_USER_ID, { type: "text", text: "【テスト】毎分送信中" }); }
//   catch (err) { console.error("cron push error", err); }
// }, { timezone: TZ });

for (const s of schedules) {
  cron.schedule(s.cron, async () => {
    console.log("[cron fired]", s.text);
    if (!LAST_USER_ID) return console.log("[cron] skipped: userId missing");
    try {
      await client.pushMessage(LAST_USER_ID, { type: "text", text: s.text });
    } catch (err) {
      console.error("cron push error", err);
    }
  }, { timezone: TZ });
}

// ====== 起動 ======
app.listen(process.env.PORT || 3000, () => {
  console.log("Server OK");
});
