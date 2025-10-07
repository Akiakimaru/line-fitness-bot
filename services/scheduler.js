// services/scheduler.js
const cron = require("node-cron");
const { getWeekAndDayJST } = require("../lib/utils");
const { loadMealPlan, getAllUserIds } = require("../lib/sheets");
const line = require("@line/bot-sdk");

const TZ = "Asia/Tokyo";
const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};
const client = new line.Client(config);

/* ---------- Slot別通知 ---------- */
async function pushSlot(slotLabel) {
  const { week, day } = getWeekAndDayJST();
  const { rows, idx } = await loadMealPlan();

  const r = rows.find(
    (r) =>
      String(r._rawData[idx.Week]) === String(week) &&
      String(r._rawData[idx.Day]).toLowerCase() === day.toLowerCase() &&
      String(r._rawData[idx.Slot]) === slotLabel
  );
  if (!r) return;

  const kind = r._rawData[idx.Kind];
  let text;
  if (kind === "Meal") {
    text = `【${slotLabel}】${r._rawData[idx.Text]}（${r._rawData[idx.Calories]}kcal, P${r._rawData[idx.P]} F${r._rawData[idx.F]} C${r._rawData[idx.C]}）\n👉 ${r._rawData[idx.Tips]}`;
  } else {
    text = `【${slotLabel}】${r._rawData[idx.Text]}\n👉 ${r._rawData[idx.Tips]}`;
  }

  const users = await getAllUserIds();
  for (const uid of users) {
    await client.pushMessage(uid, { type: "text", text });
  }
}

/* ---------- cron設定 ---------- */
cron.schedule("0 7 * * *", () => pushSlot("朝"), { timezone: TZ });
cron.schedule("0 12 * * *", () => pushSlot("昼"), { timezone: TZ });
cron.schedule("0 19 * * *", () => pushSlot("夜"), { timezone: TZ });
cron.schedule("0 23 * * *", () => pushSlot("就寝"), { timezone: TZ });

module.exports = { pushSlot };
