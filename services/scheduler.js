// services/scheduler.js
const cron = require("node-cron");
const line = require("@line/bot-sdk");
const { getWeekAndDayJST, todayYMDJST } = require("../lib/utils");
const { 
  loadMealPlan, 
  getAllUserIds,
  getActiveShoppingPlan,
  saveDailyMenu,
  getDailyMenu,
  saveShoppingPlan
} = require("../lib/sheets");
const {
  generateShoppingPlan,
  generateDailyMenuWithRecipe,
  formatDailyMenuForLine
} = require("../lib/llm");

const TZ = "Asia/Tokyo";
const client = new line.Client({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
});

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
    if (!r) return console.log("[pushSlot] no record for", { week, day, slotLabel });

    const kind = String(r._rawData[idx.Kind]).trim();
    const text =
      kind === "Meal"
        ? `【${slotLabel}】${r._rawData[idx.Text]}（${r._rawData[idx.Calories]}kcal, P${r._rawData[idx.P]} F${r._rawData[idx.F]} C${r._rawData[idx.C]}）\n👉 ${r._rawData[idx.Tips] || "-"}`
        : `【${slotLabel}】${r._rawData[idx.Text]}\n👉 ${r._rawData[idx.Tips] || "-"}`;

    // 送信前に重複除去
    const users = [...new Set(await getAllUserIds())];
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

/**
 * 食事準備プッシュ（メニュー + 調理手順）
 */
async function pushMealPrep(slot, mealTime) {
  try {
    console.log(`[pushMealPrep] start: ${slot} for ${mealTime}`);
    
    const users = [...new Set(await getAllUserIds())];
    console.log(`[pushMealPrep] target users: ${users.length}`);
    
    for (const userId of users) {
      try {
        const today = todayYMDJST();
        const { week, day } = getWeekAndDayJST(process.env.START_DATE);
        
        // 既存の日次メニューを確認
        let menu = await getDailyMenu(today, slot);
        
        if (!menu) {
          // メニューがなければ生成
          console.log(`[pushMealPrep] Generating menu for ${userId}, ${today}, ${slot}`);
          
          // 買い出し計画を取得
          const shoppingPlan = await getActiveShoppingPlan(userId);
          
          if (!shoppingPlan) {
            console.warn(`[pushMealPrep] No active shopping plan for ${userId}`);
            // フォールバック: 既存のMealPlanから取得（調理手順なし）
            const { rows, idx } = await loadMealPlan();
            const r = rows.find(
              (r) =>
                String(r._rawData[idx.Week]).trim() === String(week) &&
                String(r._rawData[idx.Day]).trim().toLowerCase() === day.toLowerCase() &&
                String(r._rawData[idx.Slot]).trim() === (slot === 'breakfast' ? '朝' : slot === 'lunch' ? '昼' : '夜')
            );
            
            if (r) {
              const text = `🍽 今日の${slot === 'breakfast' ? '朝食' : slot === 'lunch' ? '昼食' : '夕食'}（${mealTime}）\n\n${r._rawData[idx.Text]}（${r._rawData[idx.Calories]}kcal, P${r._rawData[idx.P]} F${r._rawData[idx.F]} C${r._rawData[idx.C]}）\n\n👉 ${r._rawData[idx.Tips] || "-"}`;
              await client.pushMessage(userId, [{ type: "text", text }]);
              console.log(`[pushMealPrep] Sent fallback menu to ${userId}`);
            }
            continue;
          }
          
          // GPTでメニュー生成
          const menuJson = await generateDailyMenuWithRecipe(userId, today, slot, shoppingPlan);
          
          // DailyMenuシートに保存
          await saveDailyMenu({
            date: today,
            week,
            day,
            slot,
            menuName: menuJson.menuName,
            ingredients: menuJson.ingredients,
            recipe: menuJson.recipe,
            cookingTime: menuJson.cookingTime,
            pfc: menuJson.pfc,
            sourcePlan: `Week${week}`
          });
          
          menu = menuJson;
          menu.slot = slot;
        }
        
        // メニューを整形して送信
        const text = formatDailyMenuForLine(menu, mealTime);
        await client.pushMessage(userId, [{ type: "text", text }]);
        console.log(`[pushMealPrep] Sent menu to ${userId}`);
        
      } catch (userError) {
        console.error(`[pushMealPrep] Failed for user ${userId}:`, userError);
      }
    }
    
  } catch (error) {
    console.error(`[pushMealPrep] fatal:`, error);
  }
}

// cron登録（JST）
cron.schedule("0 5 * * *", () => pushSlot("ジム"), { timezone: TZ }); // 朝ジム
cron.schedule("0 7 * * *", () => pushMealPrep("breakfast", "8:00"), { timezone: TZ }); // 朝食準備
cron.schedule("0 11 * * *", () => pushMealPrep("lunch", "12:00"), { timezone: TZ }); // 昼食準備
cron.schedule("0 18 * * *", () => pushMealPrep("dinner", "19:00"), { timezone: TZ }); // 夕食準備

// 追加: 次週メニューの自動生成（毎週土曜 23:00 JST）
const { generateNextWeekWithGPT } = require("../lib/llm");

cron.schedule("0 23 * * Sat", async () => {
  try {
    const r = await generateNextWeekWithGPT();
    console.log("[auto-gen] result:", r);
  } catch (e) {
    console.error("[auto-gen] error:", e);
  }
}, { timezone: TZ });

/**
 * 買い出し計画の週次自動生成（毎週月曜 21:00 JST）
 */
cron.schedule("0 21 * * Mon", async () => {
  try {
    console.log("[auto-shopping-plan] Starting weekly shopping plan generation...");
    
    const users = [...new Set(await getAllUserIds())];
    console.log(`[auto-shopping-plan] Target users: ${users.length}`);
    
    for (const userId of users) {
      try {
        const { week } = getWeekAndDayJST(process.env.START_DATE);
        const nextWeek = week + 1;
        
        // 買い出し計画を生成
        const planJson = await generateShoppingPlan(userId);
        
        // 有効期限を計算（火曜日〜次週月曜日）
        const now = new Date();
        const nextTuesday = new Date(now);
        nextTuesday.setDate(now.getDate() + ((2 - now.getDay() + 7) % 7 || 7)); // 次の火曜
        const nextNextMonday = new Date(nextTuesday);
        nextNextMonday.setDate(nextTuesday.getDate() + 6); // 火曜+6日=月曜
        
        // ShoppingPlanシートに保存
        await saveShoppingPlan({
          userId,
          week: nextWeek,
          validFrom: nextTuesday.toISOString().split('T')[0],
          validUntil: nextNextMonday.toISOString().split('T')[0],
          planJson,
          status: 'active'
        });
        
        console.log(`[auto-shopping-plan] Generated plan for ${userId}, week ${nextWeek}`);
        
        // ユーザーに通知（オプション）
        await client.pushMessage(userId, [{
          type: "text",
          text: `📋 来週の買い出し計画を作成しました！\n「買い出し計画」と送信して確認してください。`
        }]);
        
      } catch (userError) {
        console.error(`[auto-shopping-plan] Failed for user ${userId}:`, userError);
      }
    }
    
    console.log("[auto-shopping-plan] Completed");
    
  } catch (error) {
    console.error("[auto-shopping-plan] fatal:", error);
  }
}, { timezone: TZ });


module.exports = { pushSlot, pushMealPrep };
