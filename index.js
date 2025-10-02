require("dotenv").config();
const express = require("express");
const line = require("@line/bot-sdk");
const cron = require("node-cron");

const app = express();

// --- LINE SDK設定 ---
const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};
const client = new line.Client(config);

// --- ユーザー保持（簡易） ---
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
// express.json() は入れないこと！ line.middleware(config) が自動で処理
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

  if (e.message.type === "text") {
    const t = (e.message.text || "").trim();

    if (t.includes("テスト")) {
      return client.replyMessage(e.replyToken, {
        type: "text",
        text: "受け取ったぞ。準備はできているか？",
      });
    }

    // デフォルト応答
    return client.replyMessage(e.replyToken, {
      type: "text",
      text: "OK、受け取った。",
    });
  }
}

// --- 定時リマインド（テスト用:毎分） ---
cron.schedule("* * * * *", async () => {
  console.log("[cron fired] 毎分テストPush");
  try {
    if (!LAST_USER_ID) return;
    await client.pushMessage(LAST_USER_ID, { type: "text", text: "毎分テストPush通知" });
  } catch (err) {
    console.error("cron push error", err);
  }
}, { timezone: "Asia/Tokyo" });

// --- サーバー起動 ---
app.listen(process.env.PORT || 3000, () => {
  console.log("Server OK");
});
