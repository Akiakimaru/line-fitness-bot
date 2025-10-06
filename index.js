// index.js (entry)
require("dotenv").config();
const express = require("express");
const line = require("@line/bot-sdk");
const cron = require("node-cron");

const { TZ, getWeekAndDayJST } = require("./lib/utils");
const { getTodaySlotText } = require("./services/lineHandlers");
const makeAdminRoutes = require("./routes/admin");
const { handleEvent, getLastUserId } = require("./services/lineHandlers");

const app = express();

/* LINE client */
const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};
const client = new line.Client(lineConfig);

/* Health */
app.get("/", (_req, res) => res.send("LINE Fitness Bot OK"));

/* Webhook */
app.post("/webhook", line.middleware(lineConfig), async (req, res) => {
  try {
    await Promise.all((req.body.events || []).map((e) => handleEvent(e, client)));
    res.sendStatus(200);
  } catch (e) {
    console.error("Webhook error", e);
    res.sendStatus(500);
  }
});

/* Push helpers */
async function pushSlot(slotLabel) {
  const userId = getLastUserId();
  if (!userId) return;
  const txt = await getTodaySlotText(slotLabel);
  if (txt) await client.pushMessage(userId, { type: "text", text: txt });
}

/* Cron */
cron.schedule("0 7 * * *", () => pushSlot("朝"), { timezone: TZ });
cron.schedule("0 12 * * *", () => pushSlot("昼"), { timezone: TZ });
cron.schedule("0 19 * * *", () => pushSlot("夜"), { timezone: TZ });
cron.schedule("0 23 * * *", () => pushSlot("就寝"), { timezone: TZ });

/* Admin & Debug routes */
app.use(makeAdminRoutes(process.env.ADMIN_KEY || "", client, getLastUserId, pushSlot));

/* Start */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on :${PORT}`));
