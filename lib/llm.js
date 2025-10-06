// lib/llm.js
const OpenAI = require("openai");
const { withBackoff } = require("./utils");
const { loadMealPlan, getRecentLogs, chunkAddRows } = require("./sheets");

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function looksLikeHeaderRow(cols) {
  if (!cols || cols.length < 2) return false;
  const head = cols.slice(0, 5).map((s) => String(s).trim());
  return head[0] === "Week" && head[1] === "Day" && head[2] === "Kind" && head[3] === "Slot" && head[4] === "Text";
}

// 1-A: CSVクレンジング（コードフェンス除去・ヘッダー検証・二重ヘッダー掃除・行数警告）
function cleanseCsv(raw) {
  const csv = raw.replace(/^```[a-z]*\n?/i, "").replace(/\n?```$/, "").trim();
  const lines = csv.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (!lines.length) return { header: [], rows: [] };

  const header = lines[0].split(",").map((s) => s.trim());
  const expected = ["Week", "Day", "Kind", "Slot", "Text", "Calories", "P", "F", "C", "Tips"];
  if (header.join("|") !== expected.join("|")) {
    throw new Error("CSV header mismatch");
  }

  const body = lines.slice(1);
  const rows = body.filter((line) => {
    const cols = line.split(",");
    return !(cols[0] === "Week" && cols[1] === "Day");
  });

  if (rows.length !== 35) {
    console.warn(`[warn] expected 35 rows, got ${rows.length}`);
  }
  return { header, rows };
}

async function generateNextWeekWithGPT(getWeekAndDayJST) {
  const { week } = getWeekAndDayJST(process.env.START_DATE);
  const nextWeek = week + 1;

  const { sheet, rows, idx } = await loadMealPlan();
  const exists = rows.some((r) => String(r._rawData[idx.Week]).trim() === String(nextWeek));
  if (exists) return { created: 0, skipped: true, week: nextWeek };

  // 現週の簡易要約
  const thisWeekRows = rows.filter((r) => String(r._rawData[idx.Week]).trim() === String(week));
  const brief = thisWeekRows
    .slice(0, 50)
    .map((r) => {
      return [
        String(r._rawData[idx.Day]).trim(),
        String(r._rawData[idx.Kind]).trim(),
        String(r._rawData[idx.Slot]).trim(),
        String(r._rawData[idx.Text]).trim(),
        String(r._rawData[idx.Calories]).trim(),
        String(r._rawData[idx.P]).trim(),
        String(r._rawData[idx.F]).trim(),
        String(r._rawData[idx.C]).trim(),
      ].join("|");
    })
    .join("\n");

  // 直近ログ（10日）
  const recentLogs = await getRecentLogs(10);
  const trainLogs = recentLogs.filter((x) => x.Kind === "Training");
  const mealLogs = recentLogs.filter((x) => x.Kind === "Meal");
  const trainBrief = trainLogs.map((x) => `- ${x.Date} ${x.Slot}: ${x.Text}`).join("\n") || "- 直近トレーニング記録なし";
  const mealBrief = mealLogs.slice(-7).map((x) => `- ${x.Date} ${x.Slot}: ${x.Text}`).join("\n");

  const prompt = `あなたは管理栄養士兼パーソナルトレーナーです。
28歳男性 170cm/80kg、減量フェーズ。好み：刺身中心、パプリカ/ピーマン不可。朝ジム。PFCは高タンパク・中〜低脂質・適量炭水化物。夜は糖質控えめ。

【直近のMealPlan（参考）】
Day|Kind|Slot|Text|kcal|P|F|C
${brief}

【直近の自由入力ログ（Training抜粋）】
${trainBrief}

【直近の自由入力ログ（Meal一部）】
${mealBrief}

次週（Week=${nextWeek}）の7日分のメニュー（Meal: 朝/昼/夜/就寝、Training: ジム or 休養）を **CSV** で出力。
列は固定：Week,Day,Kind,Slot,Text,Calories,P,F,C,Tips

ルール：
- Dayは Mon,Tue,Wed,Thu,Fri,Sat,Sun
- Kindは Meal / Training
- Slotは Mealなら「朝/昼/夜/就寝」、Trainingなら「ジム」または「休養」
- Text/Tipsは日本語。**カンマは使わず**「・」等で表現（CSV崩れ防止）
- Calories,P,F,C は整数（空欄可だが原則入れる）
- 7日分の Meal(4×7=28行) と Training(1×7=7行) の合計35行
- 一行目はヘッダー（上記列名）。以降に35行。
- **Training の Text は必ず具体的な種目・回数や時間を含む**（例：胸：ベンチプレス4x8・インクラインDB3x12・HIIT10分）
- 前週に過負荷の部位は翌日休養/別部位に分散（部位ローテーション：胸/背/脚/肩/腕/休養）
`;

  const res = await withBackoff(() =>
    openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.2,
      messages: [{ role: "user", content: prompt }],
    })
  );

  const raw = (res.choices?.[0]?.message?.content || "").trim();
  const { rows: filtered } = cleanseCsv(raw);

  const toInsert = [];
  for (const line of filtered) {
    const cols = line.split(",");
    if (looksLikeHeaderRow(cols)) continue;
    if (cols.length < 10) continue;
    const row = {
      Week: cols[0],
      Day: cols[1],
      Kind: cols[2],
      Slot: cols[3],
      Text: cols[4],
      Calories: cols[5],
      P: cols[6],
      F: cols[7],
      C: cols[8],
      Tips: cols[9],
    };
    if (!row.Week || !row.Day || !row.Kind || !row.Slot || !row.Text) continue;
    toInsert.push(row);
  }

  let created = 0;
  if (toInsert.length) {
    await chunkAddRows(sheet, toInsert);
    created = toInsert.length;
  }
  return { created, skipped: false, week: nextWeek };
}

module.exports = { generateNextWeekWithGPT };
