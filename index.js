require("dotenv").config();
const express = require("express");
const line = require("@line/bot-sdk");
const { GoogleSpreadsheet } = require("google-spreadsheet");
const { JWT } = require("google-auth-library");
const cron = require("node-cron");
const OpenAI = require("openai");

const app = express();

/* ================= LINE ================= */
const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};
const client = new line.Client(config);

/* ================= OpenAI ================= */
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/* ================= Google Sheets (v5) ================= */
const serviceAccount = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
const jwt = new JWT({
  email: serviceAccount.client_email,
  key: serviceAccount.private_key,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID, jwt);

/* ================= Helpers: JST ================= */
const TZ = "Asia/Tokyo";
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const ADMIN_KEY = process.env.ADMIN_KEY || ""; // 管理用キー

function nowJST() {
  return new Date(Date.now() + 9 * 60 * 60 * 1000);
}
function parseYMDAsJST(ymd) {
  return new Date(`${ymd}T00:00:00+09:00`);
}
function getWeekAndDayJST() {
  const start = parseYMDAsJST(process.env.START_DATE);
  const now = nowJST();
  const diffDays = Math.floor((now - start) / (1000 * 60 * 60 * 24));
  const week = Math.max(1, Math.floor(diffDays / 7) + 1);
  const day = DAYS[now.getUTCDay()]; // JSTへ+9h後の曜日を取得
  return { week, day, jstISO: now.toISOString() };
}

/* ================= State ================= */
let LAST_USER_ID = null;     // Push送信用（単独運用想定）
let editContext = null;      // { slot, draft? }

/* ================= Sheet Access (header-indexed) ================= */
async function loadMealPlan() {
  await doc.loadInfo();
  const sheet = doc.sheetsByTitle["MealPlan"];
  if (!sheet) throw new Error("MealPlan sheet not found");
  const rows = await sheet.getRows();

  const H = sheet.headerValues; // ["Week","Day","Kind","Slot","Text","Calories","P","F","C","Tips"]
  const idx = {
    Week: H.indexOf("Week"),
    Day: H.indexOf("Day"),
    Kind: H.indexOf("Kind"),
    Slot: H.indexOf("Slot"),
    Text: H.indexOf("Text"),
    Calories: H.indexOf("Calories"),
    P: H.indexOf("P"),
    F: H.indexOf("F"),
    C: H.indexOf("C"),
    Tips: H.indexOf("Tips"),
  };
  Object.entries(idx).forEach(([k, v]) => {
    if (v === -1) throw new Error(`Header "${k}" not found in MealPlan`);
  });

  return { sheet, rows, idx, headers: H };
}
const cell = (row, i) => String((row._rawData && row._rawData[i]) ?? "").trim();

/* ================= Debug Routes (GET) ================= */
app.get("/", (_req, res) => res.send("LINE Fitness Bot OK"));
app.get("/whoami", (_req, res) =>
  res.json({ userIdSet: !!LAST_USER_ID, lastUserId: LAST_USER_ID })
);
app.get("/debug-week", (_req, res) => {
  res.json({ START_DATE: process.env.START_DATE, ...getWeekAndDayJST() });
});
app.get("/debug-today", async (_req, res) => {
  try {
    const { week, day } = getWeekAndDayJST();
    const { rows, idx, headers } = await loadMealPlan();
    const matches = rows
      .filter(
        (r) =>
          cell(r, idx.Week) === String(week) &&
          cell(r, idx.Day).toLowerCase() === day.toLowerCase()
      )
      .map((r) => r._rawData);
    res.json({ target: { week, day }, headers, hitCount: matches.length, matches });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

/* ================= 今日のメニュー（全文） ================= */
async function getTodayMenuText() {
  const { week, day } = getWeekAndDayJST();
  const { rows, idx } = await loadMealPlan();
  const today = rows.filter(
    (r) =>
      cell(r, idx.Week) === String(week) &&
      cell(r, idx.Day).toLowerCase() === day.toLowerCase()
  );
  if (!today.length) return `今日のメニューは未設定です。\n（Week${week} ${day})`;

  const meals = today.filter((r) => cell(r, idx.Kind) === "Meal");
  const trainings = today.filter((r) => cell(r, idx.Kind) === "Training");

  let text = `【今日のメニュー】(Week${week} ${day})\n\n🍽 食事\n`;
  for (const r of meals) {
    const slot = cell(r, idx.Slot);
    const desc = cell(r, idx.Text);
    const kcal = cell(r, idx.Calories);
    const P = cell(r, idx.P);
    const F = cell(r, idx.F);
    const C = cell(r, idx.C);
    const tips = cell(r, idx.Tips) || "-";
    text += `- ${slot}: ${desc} （${kcal}kcal, P${P} F${F} C${C}）\n  👉 ${tips}\n`;
  }
  if (trainings.length) {
    text += `\n💪 トレーニング\n`;
    for (const r of trainings) {
      const slot = cell(r, idx.Slot);
      const desc = cell(r, idx.Text);
      const tips = cell(r, idx.Tips) || "-";
      text += `- ${slot}: ${desc}\n  👉 ${tips}\n`;
    }
  }
  return text;
}

/* ================= Slot別テキスト ================= */
async function getTodaySlotText(slotLabel) {
  const { week, day } = getWeekAndDayJST();
  const { rows, idx } = await loadMealPlan();
  const r = rows.find(
    (r) =>
      cell(r, idx.Week) === String(week) &&
      cell(r, idx.Day).toLowerCase() === day.toLowerCase() &&
      cell(r, idx.Slot) === slotLabel &&
      ["Meal", "Training"].includes(cell(r, idx.Kind))
  );
  if (!r) return null;

  if (cell(r, idx.Kind) === "Meal") {
    const kcal = cell(r, idx.Calories);
    const P = cell(r, idx.P);
    const F = cell(r, idx.F);
    const C = cell(r, idx.C);
    const tips = cell(r, idx.Tips) || "-";
    return `【${slotLabel}】${cell(r, idx.Text)}（${kcal}kcal, P${P} F${F} C${C}）\n👉 ${tips}`;
  } else {
    const tips = cell(r, idx.Tips) || "-";
    return `【${slotLabel}】${cell(r, idx.Text)}\n👉 ${tips}`;
  }
}

/* ================= LINE Webhook（※body-parser不要） ================= */
app.post("/webhook", line.middleware(config), async (req, res) => {
  try {
    await Promise.all((req.body.events || []).map(handleEvent));
    res.sendStatus(200);
  } catch (e) {
    console.error("Webhook error", e);
    res.sendStatus(500);
  }
});

async function handleEvent(e) {
  if (e?.source?.userId) LAST_USER_ID = e.source.userId;
  if (e.type !== "message" || e.message?.type !== "text") return;

  const msg = (e.message.text || "").trim();

  // ===== 編集フロー =====
  if (/^編集\s*(朝|昼|夜|就寝|ジム)$/.test(msg)) {
    const slot = msg.replace("編集", "").trim();
    editContext = { slot, draft: "" };
    return client.replyMessage(e.replyToken, {
      type: "text",
      text: `「${slot}」の新しい本文を送ってください。`,
    });
  }

  if (editContext && !/^はい$|^いいえ$/.test(msg)) {
    // 下書き受領 → 確認
    editContext.draft = msg;
    return client.replyMessage(e.replyToken, {
      type: "text",
      text: `以下で更新します。よろしいですか？\n\n【${editContext.slot}】\n${editContext.draft}`,
      quickReply: {
        items: [
          { type: "action", action: { type: "message", label: "はい", text: "はい" } },
          { type: "action", action: { type: "message", label: "いいえ", text: "いいえ" } },
        ],
      },
    });
  }

  if (editContext && /^いいえ$/.test(msg)) {
    editContext = null;
    return client.replyMessage(e.replyToken, { type: "text", text: "キャンセルしました。" });
  }

  if (editContext && /^はい$/.test(msg)) {
    const { slot, draft } = editContext;
    editContext = null;

    const { week, day } = getWeekAndDayJST();
    const { rows, idx } = await loadMealPlan();
    const target = rows.find(
      (r) =>
        cell(r, idx.Week) === String(week) &&
        cell(r, idx.Day).toLowerCase() === day.toLowerCase() &&
        cell(r, idx.Slot) === slot
    );
    if (!target) {
      return client.replyMessage(e.replyToken, { type: "text", text: "該当スロットが見つかりませんでした。" });
    }
    target._rawData[idx.Text] = draft;
    await target.save();
    return client.replyMessage(e.replyToken, {
      type: "text",
      text: `更新完了 ✅\n【${slot}】\n${draft}`
    });
  }

  // ===== 手動のGPT生成（LINEから） =====
  if (msg.includes("来週メニュー生成")) {
    const r = await generateNextWeekWithGPT();
    return client.replyMessage(e.replyToken, { type: "text", text: r.skipped ? `Week${r.week} は既に存在。スキップしました。` : `Week${r.week} を自動生成：${r.created}行` });
  }

  // ===== 通常コマンド =====
  if (msg.includes("今日のメニュー")) {
    const menu = await getTodayMenuText();
    return client.replyMessage(e.replyToken, { type: "text", text: menu });
  }

  return client.replyMessage(e.replyToken, {
    type: "text",
    text: "コマンドを選んでください。",
    quickReply: {
      items: [
        { type: "action", action: { type: "message", label: "今日のメニュー", text: "今日のメニュー" } },
        { type: "action", action: { type: "message", label: "編集 昼", text: "編集 昼" } },
        { type: "action", action: { type: "message", label: "来週メニュー生成", text: "来週メニュー生成" } },
      ],
    },
  });
}

/* ================= スロット別リマインド（JST） ================= */
async function pushSlot(slotLabel) {
  if (!LAST_USER_ID) return;
  const txt = await getTodaySlotText(slotLabel);
  if (txt) await client.pushMessage(LAST_USER_ID, { type: "text", text: txt });
}
cron.schedule("0 7 * * *", () => pushSlot("朝"), { timezone: TZ });
cron.schedule("0 12 * * *", () => pushSlot("昼"), { timezone: TZ });
cron.schedule("0 19 * * *", () => pushSlot("夜"), { timezone: TZ });
cron.schedule("0 23 * * *", () => pushSlot("就寝"), { timezone: TZ });

/* ================= GPT: 次週メニュー自動生成 ================= */
async function generateNextWeekWithGPT() {
  const { week } = getWeekAndDayJST();
  const nextWeek = week + 1;

  const { sheet, rows, idx } = await loadMealPlan();
  // 既に次週があるなら skip（冪等）
  const exists = rows.some((r) => cell(r, idx.Week) === String(nextWeek));
  if (exists) return { created: 0, skipped: true, week: nextWeek };

  // 直近の週を要約してプロンプト安定化
  const thisWeekRows = rows.filter((r) => cell(r, idx.Week) === String(week));
  const brief = thisWeekRows.slice(0, 50).map((r) => {
    return [
      cell(r, idx.Day),
      cell(r, idx.Kind),
      cell(r, idx.Slot),
      cell(r, idx.Text),
      cell(r, idx.Calories), cell(r, idx.P), cell(r, idx.F), cell(r, idx.C)
    ].join("|");
  }).join("\n");

  const prompt = `あなたは管理栄養士とパーソナルトレーナーのハイブリッドです。
28歳・男性・170cm・80kg、減量フェーズ。好み：魚は刺身中心、オートミールは少量・食べやすい形、パプリカ/ピーマン不可。朝ジム。PFCは高タンパク・中〜低脂質・適量炭水化物。夜は糖質控えめ。

【直近の実績（参考 / 簡易）】
Day|Kind|Slot|Text|kcal|P|F|C
${brief}

次週（Week=${nextWeek}）の7日分のメニュー（Meal: 朝/昼/夜/就寝、Training: ジム or 休養）を **CSV** で出力してください。
列は固定：Week,Day,Kind,Slot,Text,Calories,P,F,C,Tips

ルール：
- Dayは Mon,Tue,Wed,Thu,Fri,Sat,Sun
- Kindは Meal / Training
- Slotは Mealなら「朝/昼/夜/就寝」、Trainingなら「ジム」または「休養」
- Text/Tipsは日本語。**カンマは使わず**「・」などで表現（CSV崩れ防止）
- Calories,P,F,C は整数（空欄可だが原則入れる）
- 7日分の Meal(4行×7日=28行) と Training(1行×7日=7行) の合計35行を必ず出力
- 一行目はヘッダー（上記列名）。以降に35行。`;

  const res = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.2,
  });

  const csv = (res.choices?.[0]?.message?.content || "").trim();
  const lines = csv.split(/\r?\n/);
  if (!lines.length) return { created: 0, skipped: false, week: nextWeek, warn: "empty csv" };

  // ヘッダーを落として行追加（カンマ禁止を課しているので単純splitでOK）
  const body = lines.slice(1).filter(Boolean);
  let created = 0;
  for (const line of body) {
    const cols = line.split(",");
    if (cols.length < 10) continue;
    const row = {
      Week: cols[0], Day: cols[1], Kind: cols[2], Slot: cols[3],
      Text: cols[4], Calories: cols[5], P: cols[6], F: cols[7], C: cols[8], Tips: cols[9],
    };
    if (!row.Week || !row.Day || !row.Kind || !row.Slot || !row.Text) continue;
    await sheet.addRow(row);
    created++;
  }
  return { created, skipped: false, week: nextWeek };
}

// 土曜 23:00 JST に自動生成
cron.schedule("0 23 * * Sat", async () => {
  try {
    const result = await generateNextWeekWithGPT();
    console.log("[auto-gen] result:", result);
    if (LAST_USER_ID) {
      const msg = result.skipped
        ? `Week${result.week} は既に存在。自動生成スキップ。`
        : `Week${result.week} を自動生成：${result.created}行 追加。`;
      await client.pushMessage(LAST_USER_ID, { type: "text", text: msg });
    }
  } catch (e) {
    console.error("auto-gen error", e);
  }
}, { timezone: TZ });

/* ================= 月初アーカイブ（4週より前） ================= */
async function archiveOldWeeks(keepRecentN = 4) {
  const { week } = getWeekAndDayJST();
  const { sheet, rows, idx, headers } = await loadMealPlan();
  const cutoff = week - keepRecentN;
  if (cutoff < 1) return { moved: 0 };

  const toMove = rows.filter(r => {
    const w = parseInt(cell(r, idx.Week) || "0", 10);
    return Number.isFinite(w) && w > 0 && w <= cutoff;
  });
  if (!toMove.length) return { moved: 0 };

  const now = nowJST();
  const name = `Archive_${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}`;

  let archive = doc.sheetsByTitle[name];
  if (!archive) {
    archive = await doc.addSheet({ title: name, headerValues: headers });
  }
  let moved = 0;
  for (const r of toMove) {
    await archive.addRow(r._rawData);
    await r.delete();
    moved++;
  }
  return { moved, archiveName: name };
}

// 毎月1日 03:00 JST
cron.schedule("0 3 1 * *", async () => {
  try {
    const result = await archiveOldWeeks(4);
    console.log("[archive] result:", result);
    if (LAST_USER_ID && result.moved) {
      await client.pushMessage(LAST_USER_ID, {
        type: "text",
        text: `アーカイブ完了：${result.moved}件を ${result.archiveName} へ移動。`,
      });
    }
  } catch (e) {
    console.error("archive error", e);
  }
}, { timezone: TZ });

/* ================= 管理者用：手動テストエンドポイント ================= */
app.get("/admin/auto-gen", async (req, res) => {
  if (req.query.key !== ADMIN_KEY) return res.status(401).send("unauthorized");
  try {
    const result = await generateNextWeekWithGPT();
    res.json({ ok: true, result });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.get("/admin/push-slot", async (req, res) => {
  if (req.query.key !== ADMIN_KEY) return res.status(401).send("unauthorized");
  const slot = req.query.slot || "昼";
  try {
    await pushSlot(slot);
    res.json({ ok: true, slot, to: LAST_USER_ID });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.get("/admin/archive", async (req, res) => {
  if (req.query.key !== ADMIN_KEY) return res.status(401).send("unauthorized");
  try {
    const result = await archiveOldWeeks(4);
    res.json({ ok: true, result });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.get("/admin/today", async (req, res) => {
  if (req.query.key !== ADMIN_KEY) return res.status(401).send("unauthorized");
  try {
    const text = await getTodayMenuText();
    res.json({ ok: true, text });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

/* ================= 起動 ================= */
app.listen(process.env.PORT || 3000, () => {
  console.log("Server running");
});
