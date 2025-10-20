// lib/llm.js
const OpenAI = require("openai");
const { loadMealPlan, readRecentLogs } = require("./sheets");
const { getWeekAndDayJST } = require("./utils");

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MEAL_SLOTS = ["朝", "昼", "夜", "就寝"];

function looksLikeHeader(cols) {
  const h = cols.map((s) => String(s || "").trim());
  return h[0] === "Week" && h[1] === "Day" && h[2] === "Kind" && h[3] === "Slot" && h[4] === "Text";
}

function normalizeDay(d) {
  const s = String(d || "").trim().toLowerCase();
  const map = {
    mon: "Mon", monday: "Mon", "月": "Mon",
    tue: "Tue", tuesday: "Tue", "火": "Tue",
    wed: "Wed", wednesday: "Wed", "水": "Wed",
    thu: "Thu", thursday: "Thu", "木": "Thu",
    fri: "Fri", friday: "Fri", "金": "Fri",
    sat: "Sat", saturday: "Sat", "土": "Sat",
    sun: "Sun", sunday: "Sun", "日": "Sun",
  };
  return map[s] || null;
}

function scrubTextField(s) {
  return String(s || "")
    .replace(/,/g, "・")
    .replace(/\r?\n/g, " / ")
    .replace(/\t/g, " ");
}

/** LLM出力からCSV本体を抽出 */
function extractCsvBody(raw) {
  if (!raw) return "";
  const txt = String(raw).trim();
  const fence = txt.match(/```(?:csv)?\s*([\s\S]*?)```/i);
  const body = fence ? fence[1] : txt;
  const lines = body.split(/\r?\n/);
  let headerIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const cols = lines[i].split(",");
    if (looksLikeHeader(cols)) { headerIdx = i; break; }
  }
  if (headerIdx === -1) return "";
  return lines.slice(headerIdx).join("\n");
}

function cleanseAndNormalize(csv, nextWeek) {
  const out = [];
  if (!csv) return out;
  const lines = csv.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return out;
  const header = lines[0].split(",");
  if (!looksLikeHeader(header)) return out;

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",");
    if (looksLikeHeader(cols)) continue;
    if (cols.length < 10) continue;

    let [w, d, kind, slot, text, kcal, P, F, C, tips] = cols;

    const week = String(w || "").trim() || String(nextWeek);
    const day = normalizeDay(d) || d;
    const k = String(kind || "").trim();
    const s = String(slot || "").trim();
    const t = scrubTextField(text);
    const tip = scrubTextField(tips);

    if (!DAYS.includes(day)) continue;
    if (!["Meal", "Training"].includes(k)) continue;
    if (k === "Meal" && !MEAL_SLOTS.includes(s)) continue;
    if (k === "Training" && !["ジム", "休養"].includes(s)) continue;

    out.push({
      Week: week,
      Day: day,
      Kind: k,
      Slot: s,
      Text: t,
      Calories: String(kcal || "").trim(),
      P: String(P || "").trim(),
      F: String(F || "").trim(),
      C: String(C || "").trim(),
      Tips: tip,
    });
  }
  return out;
}

function ensureWeeklyCompleteness(rows, nextWeek) {
  const byKey = new Map();
  for (const r of rows) {
    const key = `${r.Week}|${r.Day}|${r.Kind}|${r.Slot}`;
    byKey.set(key, r);
  }
  const ensured = [];
  for (const day of DAYS) {
    for (const slot of MEAL_SLOTS) {
      const key = `${nextWeek}|${day}|Meal|${slot}`;
      let row = byKey.get(key);
      if (!row) {
        row = {
          Week: String(nextWeek),
          Day: day,
          Kind: "Meal",
          Slot: slot,
          Text: "（未設定）",
          Calories: "", P: "", F: "", C: "",
          Tips: "-",
        };
      }
      ensured.push(row);
    }
    const kGym = `${nextWeek}|${day}|Training|ジム`;
    const kRest = `${nextWeek}|${day}|Training|休養`;
    let row = byKey.get(kGym) || byKey.get(kRest);
    if (!row) {
      row = {
        Week: String(nextWeek),
        Day: day,
        Kind: "Training",
        Slot: "休養",
        Text: "完全休養（ストレッチ10分）",
        Calories: "", P: "", F: "", C: "",
        Tips: "睡眠最優先",
      };
    }
    ensured.push(row);
  }
  return ensured;
}

/** Logs を要約して次週プロンプトへ渡すテキストへ */
async function summarizeRecentLogsForPrompt(days = 7) {
  const logs = await readRecentLogs(days);
  if (!logs.length) return "(直近ログなし)";

  // ざっくり集計
  let weights = [];
  let meals = [];
  let gymSets = 0, gymMinutes = 0;
  const mealTerms = new Map(); // 出現頻度

  for (const r of logs) {
    if (r.Kind === "Weight") {
      const v = parseFloat(r.Text);
      if (!Number.isNaN(v)) weights.push(v);
    } else if (r.Kind === "Meal") {
      meals.push(r.Text);
      // 単純分かち（読点・中黒などを区切りに）
      String(r.Text).split(/[・、,\/\s]+/).forEach(tok => {
        const t = tok.trim();
        if (!t) return;
        mealTerms.set(t, (mealTerms.get(t) || 0) + 1);
      });
    } else if (r.Kind === "Gym") {
      const meta = r.Meta || {};
      if (Array.isArray(meta.parsed)) {
        for (const ex of meta.parsed) {
          if (Array.isArray(ex.sets)) gymSets += ex.sets.length;
          if (ex.minutes) gymMinutes += Number(ex.minutes) || 0;
        }
      }
    }
  }

  const topMeals = Array.from(mealTerms.entries())
    .sort((a,b)=>b[1]-a[1])
    .slice(0,5)
    .map(([k,v])=>`${k}×${v}`).join("・") || "-";

  const wMin = weights.length ? Math.min(...weights) : null;
  const wMax = weights.length ? Math.max(...weights) : null;
  const wAvg = weights.length ? (weights.reduce((a,b)=>a+b,0)/weights.length) : null;

  const weightLine = weights.length
    ? `体重: 平均${wAvg.toFixed(1)}kg・最小${wMin.toFixed(1)}kg・最大${wMax.toFixed(1)}kg`
    : "体重: 記録不足";

  const gymLine = `ジム: セット合計${gymSets}・有酸素${gymMinutes}分`;
  const mealLine = `頻出食材/メニュー: ${topMeals}`;

  return [
    weightLine.replace(/,/g,"・"),
    gymLine.replace(/,/g,"・"),
    mealLine.replace(/,/g,"・")
  ].join("\n");
}

async function generateNextWeekWithGPT(getWeekAndDay = getWeekAndDayJST) {
  const { week: currentWeek } = getWeekAndDay(process.env.START_DATE);
  const nextWeek = currentWeek + 1;

  // 既に次週があるなら skip
  const { sheet, rows, idx } = await loadMealPlan();
  const exists = rows.some((r) => String(r._rawData[idx.Week]).trim() === String(nextWeek));
  if (exists) return { created: 0, skipped: true, week: nextWeek, reason: "already-exists" };

  // 今週の概要（既存）
  const thisWeek = rows.filter((r) => String(r._rawData[idx.Week]).trim() === String(currentWeek));
  const brief = thisWeek.slice(0, 50).map((r) => {
    const get = (i) => String((r._rawData && r._rawData[i]) || "").trim();
    return [get(idx.Day), get(idx.Kind), get(idx.Slot), get(idx.Text), get(idx.Calories), get(idx.P), get(idx.F), get(idx.C)].join("|");
  }).join("\n");

  // 直近ログの要約（新規）
  const logsSummary = await summarizeRecentLogsForPrompt(7);

  const sys = `あなたは管理栄養士とパーソナルトレーナーのハイブリッドです。`;
  const user = `クライアント条件: 28歳男性 170cm 80kg 減量。刺身中心・オートミール少量・パプリカ/ピーマン不可。朝ジム。高タンパク・中〜低脂質・適量炭水化物。夜は糖質控えめ。

【直近の実績（今週の MealPlan 抜粋）】
Day|Kind|Slot|Text|kcal|P|F|C
${brief}

【直近7日 Logs の要約】
${logsSummary}

次週（Week=${nextWeek}）の7日分のメニューを **CSV** で出力してください。
列は固定：Week,Day,Kind,Slot,Text,Calories,P,F,C,Tips

制約:
- Dayは Mon,Tue,Wed,Thu,Fri,Sat,Sun
- Kindは Meal / Training
- Slotは Mealなら「朝/昼/夜/就寝」、Trainingなら「ジム」または「休養」
- Text/Tipsは日本語。**カンマは使わない**（「・」「／」などを使用）
- Calories,P,F,C は整数（空欄可だが原則入力）
- **合計35行**（Meal 4×7 + Training 1×7）、**1行目は必ずヘッダー**
- 前置きや説明文、コードブロックは不要。CSV本体のみ。`;

  const res = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: sys },
      { role: "user", content: user },
    ],
    temperature: 0.2,
  });

  const raw = (res.choices?.[0]?.message?.content || "").trim();
  const body = extractCsvBody(raw);
  let rowsNorm = cleanseAndNormalize(body, nextWeek);
  rowsNorm = ensureWeeklyCompleteness(rowsNorm, nextWeek);

  const toInsert = rowsNorm.map((r) => ({
    Week: r.Week, Day: r.Day, Kind: r.Kind, Slot: r.Slot,
    Text: r.Text, Calories: r.Calories, P: r.P, F: r.F, C: r.C, Tips: r.Tips,
  }));

  // バルク追加
  let created = 0;
  const chunkSize = 50;
  for (let i = 0; i < toInsert.length; i += chunkSize) {
    const slice = toInsert.slice(i, i + chunkSize);
    /* eslint-disable no-await-in-loop */
    await sheet.addRows(slice);
    created += slice.length;
  }

  return { created, skipped: false, week: nextWeek, normalized: rowsNorm.length };
}

module.exports = { generateNextWeekWithGPT };
