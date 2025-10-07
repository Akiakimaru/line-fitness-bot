// index.js
require("dotenv").config();
const express = require("express");
const line = require("@line/bot-sdk");
const { handleEvent } = require("./services/lineHandlers");
const { generateNextWeekWithGPT } = require("./lib/llm");
const { getWeekAndDayJST } = require("./lib/utils");
const { archiveOldWeeksBatch } = require("./lib/sheets"); // 将来的に利用
require("./services/scheduler"); // cronジョブを登録（pushSlot自動実行）

const app = express();

/* ==================== LINE設定 ==================== */
const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};
const client = new line.Client(config);

/* ==================== Webhook ==================== */
app.post("/webhook", line.middleware(config), async (req, res) => {
  try {
    const events = req.body.events || [];
    await Promise.all(events.map((event) => handleEvent(event)));
    res.sendStatus(200);
  } catch (err) {
    console.error("Webhook Error:", err);
    res.status(500).send("Error");
  }
});

/* ==================== 管理・デバッグ系 ==================== */
const adminRouter = require("./routes/admin");
app.use("/", adminRouter);

/* ==================== 起動 ==================== */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on :${PORT}`);
});
