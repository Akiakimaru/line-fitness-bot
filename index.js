import express from "express";
import line from "@line/bot-sdk";
import dotenv from "dotenv";
import fetch from "node-fetch";
import cron from "node-cron";
import OpenAI from "openai";

dotenv.config();

const app = express();
app.use(express.json());

// LINE SDK設定
const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};
const client = new line.Client(config);

// OpenAI設定
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ユーザー保持（再起動で消える）
let LAST_USER_ID = null;

// 簡易エンドポイント
app.get("/", (_req, res) => res.send("LINE Bot Server OK"));
app.get("/whoami", (_req, res) => res.json({ userIdSet: !!LAST_USER_ID }));
app.get("/push-test", async (_req, res) => {
  if (!LAST_USER_ID) return res.send("No user yet");
  await client.pushMessage(LAST_USER_ID, { type: "text", text: "Pushテスト成功！" });
  res.send("Pushed");
});

// Webhook
app.post("/webhook", (req, res) => {
  Promise.all(req.body.events.map(handleEvent))
    .then(result => res.json(result))
    .catch(err => {
      console.error("Webhook error", err);
      res.status(500).end();
    });
});

// イベント処理
async function handleEvent(event) {
  if (event.type !== "message") return;

  LAST_USER_ID = event.source.userId;

  // テキストの場合
  if (event.message.type === "text") {
    const msg = event.message.text.trim();

    if (msg.includes("今日のジム")) {
      return client.replyMessage(event.replyToken, { type: "text", text: "今日のジム：スクワット、ベンチプレス、腹筋サイクリングだ。" });
    }
    if (msg.includes("今週メニュー")) {
      return client.replyMessage(event.replyToken, { type: "text", text: "今週のメニュー：月スクワット、火デッドリフト、水ベンチプレス、木ラットプル、金休養、土全身、日軽め。" });
    }

    // デフォルト返信
    const quick = {
      type: "text",
      text: "写真で証拠を出せ。今すぐ動け。",
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
    return client.replyMessage(event.replyToken, quick);
  }

  // 画像の場合
  if (event.message.type === "image") {
    await client.replyMessage(event.replyToken, { type: "text", text: "受け取った。処理中。待て。" });

    (async () => {
      try {
        const dataUrl = await fetchImageAsDataUrl(event.message.id);
        const feedback = await feedbackFromImage(dataUrl);
        if (LAST_USER_ID) {
          await client.pushMessage(LAST_USER_ID, { type: "text", text: `【最終FB】\n${feedback}` });
        }
      } catch (err) {
        console.error("Image error", err);
        if (LAST_USER_ID) {
          await client.pushMessage(LAST_USER_ID, { type: "text", text: "処理に失敗。明るく全体が映るように撮れ。" });
        }
      }
    })();
  }
}

// 画像取得
async function fetchImageAsDataUrl(messageId) {
  const stream = await client.getMessageContent(messageId);
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const buffer = Buffer.concat(chunks);
  return `data:image/jpeg;base64,${buffer.toString("base64")}`;
}

// OpenAIでフィードバック
async function feedbackFromImage(dataUrl) {
  const res = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: "あなたはフィットネストレーナー。送信された食事やトレーニング写真について短く厳しめにフィードバックしてください。" },
      { role: "user", content: [{ type: "text", text: "写真を評価して" }, { type: "image_url", image_url: { url: dataUrl } }] },
    ],
  });
  return res.choices[0].message.content.trim();
}

// スケジュール設定
const TZ = "Asia/Tokyo";
const schedules = [
  { cron: "50 5 * * *", text: "【起床リマインド】水500ml＋EAAを摂取、ジム準備。" },
  { cron: "0 6 * * *", text: "【ジム前リマインド】動的ストレッチを忘れるな。" },
  { cron: "30 7 * * *", text: "【ジム後リマインド】プロテイン＋朝食をとれ。" },
  { cron: "0 12 * * *", text: "【昼食リマインド】予定通りの昼食＋20分歩け。" },
  { cron: "0 15 * * *", text: "【間食リマインド】ナッツ＋軽いストレッチ。" },
  { cron: "0 19 * * *", text: "【夕食リマインド】予定通りの夕食をとれ。" },
  { cron: "0 23 * * *", text: "【就寝準備】ヨーグルト＋プロテイン、23時にはデバイス電源OFF。" },
];

for (const s of schedules) {
  cron.schedule(s.cron, async () => {
    console.log("[cron fired]", s.text);
    try {
      if (!LAST_USER_ID) return;
      await client.pushMessage(LAST_USER_ID, { type: "text", text: s.text });
    } catch (err) {
      console.error("cron push error", err);
    }
  }, { timezone: TZ });
}

app.listen(process.env.PORT || 3000, () => {
  console.log("Server OK");
});
