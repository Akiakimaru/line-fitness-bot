// services/scheduler.js
const cron = require("node-cron");
const line = require("@line/bot-sdk");
const { getWeekAndDayJST } = require("../lib/utils");
const { loadMealPlan, getAllUserIds } = require("../lib/sheets");

const TZ = "Asia/Tokyo";

// push は AccessToken があればOK（secret不要）
const client = new line.Client({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
});

/** スロット別に当日メッセージを生成して Users の全員へPUSH */
async function pushSlot(slotLabel) {
  try {
    console.log("[pushSlot] start:", slotLabel);

    const { week, day } = getWeekAndDayJST(process.env.START_DATE);
    const { rows, idx } = await loadMealPlan();

    const r = rows.find(
      (r) =>
        String(r._rawData[idx.Week]).trim() === String(week) &&
        String(r._rawData[idx.Day]).trim().toLowerCase() === day.toLowerCase() &&
        String(r._rawData[idx.Slot]).trim() === slotLabel
    );
    if (!r) {
      console.log("[pushSlot] no record for", { week, day, slotLabel });
      return;
    }

    const kind = String(r._rawData[idx.Kind]).trim();
    let text;
    if (kind === "Meal") {
      text = `【${slotLabel}】${r._rawData[idx.Text]}（${r._rawData[idx.Calories]}kcal, P${r._rawData[idx.P]} F${r._rawData[idx.F]} C${r._rawData[idx.C]}）\n👉 ${r._rawData[idx.Tips] || "-"}`;
    } else {
      text = `【${slotLabel}】${r._rawData[idx.Text]}\n👉 ${r._rawData[idx.Tips] || "-"}`;
    }

    const users = await getAllUserIds();
    console.log("[pushSlot] target users:", users.length);

    for (const uid of users) {
      try {
        await client.pushMessage(uid, { type: "text", text });
        console.log("[pushSlot] sent to:", uid);
      } catch (err) {
        console.error("[pushSlot] failed:", uid, err.response?.data || err.message);
      }
    }
  } catch (e) {
    console.error("[pushSlot] fatal:", e);
  }
}

// ==== cron（JST）====
cron.schedule("0 7 * * *", () => pushSlot("朝"), { timezone: TZ });
cron.schedule("0 12 * * *", () => pushSlot("昼"), { timezone: TZ });
cron.schedule("0 19 * * *", () => pushSlot("夜"), { timezone: TZ });
cron.schedule("0 23 * * *", () => pushSlot("就寝"), { timezone: TZ });

module.exports = { pushSlot };
