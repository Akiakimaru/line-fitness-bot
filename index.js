require("dotenv").config();
const express = require("express");
const line = require("@line/bot-sdk");
const OpenAI = require("openai");
const cron = require("node-cron");

const app = express();
app.use(express.json());

// --- LINE SDK設定 ---
const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};
const client = new line.Client(config);

// --- OpenAI設定 ---
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// --- ユーザー保持（再起動で消える）---
let LAST_USER_ID = null;

// --- 確認用エンドポイント ---
app.get("/", (_req, res) => res.send("LINE Bot Server OK"));
app.get("/whoami", (_req, res) => res.json({ userIdSet: !!LAST_USER_ID }));
app.get("/push-test", async (_req, res) => {
  try {
    if (!LAST_USER_ID) return res.send("userId未取得：一度Botに話しかけてください。");
    await client.pushMessage(LAST_USER_ID, {
      type: "text",
      text: "【テストPush】起きろ。水500ml＋EAAだ。",
    });
    res.send("Push送信OK");
  } catch (e) {
    console.error("push-test error", e);
    res.status(500).send("Push送信失敗");
  }
});

// --- Webhook受信 ---
app.post("/webhook", line.middleware(config), async (req, res) => {
  try {
    await Promise.all(req.body.events.map(handleEvent));
    res.sendStatus(200);
  } catch (e) {
    console.error("Webhook error", e);
    res.sendStatus(500);
  }
});

// --- イベント処理 ---
async function handleEvent(e) {
  if (!e || e.type !== "message") return;

  if (e.source?.userId) LAST_USER_ID = e.source.userId;

  // 画像受信時
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
          await client.pushMessage(LAST_USER_ID, { type: "text", text: "処理失敗。全体が映る写真で再提出。" });
        }
      }
    })();
    return;
  }

  // テキスト受信時
  if (e.message.type === "text") {
    const t = (e.message.text || "").trim();

    if (t.includes("今日の朝")) {
      return client.replyMessage(e.replyToken, { type: "text", text: "【朝】オートミール30g＋卵＋鶏むね50g。写真を送れ。" });
    }
    if (t.includes("今日の昼")) {
      return client.replyMessage(e.replyToken, { type: "text", text: "【昼】玄米150g＋刺身100〜150g。食後20分歩け。" });
    }
    if (t.includes("今日の夜")) {
      return client.replyMessage(e.replyToken, { type: "text", text: "【夜】鶏むね120g＋豆腐＋サラダ。水分も忘れるな。" });
    }
    if (t.includes("今日のジム")) {
      return client.replyMessage(e.replyToken, { type: "text", text: "【ジム】スクワット、ベンチ、腹筋。重量に逃げるな。" });
    }
    if (t.includes("就寝前")) {
      return client.replyMessage(e.replyToken, { type: "text", text: "【就寝前】ヨーグルト＋プロテイン。23時に電源OFF。" });
    }
    if (t.includes("今週メニュー")) {
      return client.replyMessage(e.replyToken, { type: "text", text: "【週メニュー】月Push/火Pull/水Legs/木軽Push/金Pull/土全身/日休養。" });
    }

    // デフォルト応答（クイックリプライ）
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

// --- 画像をDataURL化 ---
async function fetchImageAsDataUrl(messageId) {
  const stream = await client.getMessageContent(messageId);
  const chunks = [];
  for await (const c of stream) chunks.push(c);
  const buf = Buffer.concat(chunks);
  return `data:image/jpeg;base64,${buf.toString("base64")}`;
}

// --- OpenAIでフィードバック ---
async function feedbackFromImage(dataUrl) {
  const res = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: "あなたは厳しめのトレーナー。写真の食事やトレーニングを短く指摘する。" },
      {
        role: "user",
        content: [
          { type: "text", text: "写真を評価して" },
          { type: "image_url", image_url: { url: dataUrl } },
        ],
      },
    ],
  });
  return res.choices[0].message.content.trim();
}

// --- 定時リマインド ---
const TZ = "Asia/Tokyo";
const schedules = [
  { cron: "50 5 * * *", text: "【起床】水500ml＋EAA。準備しろ。" },
  { cron: "0 6 * * *", text: "【ジム前】動的ストレッチ。" },
  { cron: "30 7 * * *", text: "【ジム後】プロテイン＋朝食。" },
  { cron: "0 12 * * *", text: "【昼】予定通りの昼食＋20分歩け。" },
  { cron: "0 15 * * *", text: "【間食】ナッツ＋ストレッチ。" },
  { cron: "0 19 * * *", text: "【夕食】予定通りの夕食をとれ。" },
  { cron: "0 23 * * *", text: "【就寝前】ヨーグルト＋プロテイン。23時電源OFF。" },
];

for (const s of schedules) {
  cron.schedule(
    s.cron,
    async () => {
      console.log("[cron fired]", s.text);
      try {
        if (!LAST_USER_ID) return;
        await client.pushMessage(LAST_USER_ID, { type: "text", text: s.text });
      } catch (err) {
        console.error("cron push error", err);
      }
    },
    { timezone: TZ }
  );
}

// --- サーバー起動 ---
app.listen(process.env.PORT || 3000, () => {
  console.log("Server OK");
});
