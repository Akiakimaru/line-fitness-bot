// index.js
require("dotenv").config();
const express = require("express");
const line = require("@line/bot-sdk");

// services / libs
const { handleEvent } = require("./services/lineHandlers"); // 受信イベント処理
require("./services/scheduler"); // 起動時にcron登録
const adminRouter = require("./routes/admin"); // /admin 系

const app = express();

/* ================= 静的ファイル配信 ================= */
app.use(express.static('.'));

/* ================= LINE 設定 ================= */
const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};
const client = new line.Client(config);

/* ================= ヘルスチェック ================= */
app.get("/", (_req, res) => res.send("LINE Fitness Bot OK"));

/* ================= LINE Webhook ================= */
// LINE Developers の Webhook URL は必ず
// https://<your-app>.onrender.com/webhook に設定すること
app.post("/webhook", line.middleware(config), async (req, res) => {
  try {
    const events = Array.isArray(req.body.events) ? req.body.events : [];
    for (const ev of events) {
      // デバッグログ（受信確認）
      console.log("[LINE] received event:", ev.type);
      if (ev?.source?.userId) console.log("[userId]", ev.source.userId);
      await handleEvent(ev, client);
    }
    // Verify 成功のため常に 200 を返す
    res.status(200).end();
  } catch (err) {
    console.error("[Webhook error]", err);
    res.status(500).end();
  }
});

/* ================= 管理系ルート ================= */
app.use("/", adminRouter);

/* ================= 起動 ================= */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on :${PORT}`);
});
