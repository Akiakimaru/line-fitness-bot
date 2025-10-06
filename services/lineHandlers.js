// lib/llm.js
const OpenAI = require("openai");
const { withBackoff } = require("../lib/utils");
const { loadMealPlan, getRecentLogs, chunkAddRows } = require("../lib/sheets");

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/* ================= ヘッダー/区切り検出（強化） ================= */

// 区切り候補を走査（最も出現数が多いものを採用）。該当なしは「連続空白」。
function detectDelimiterFlexible(line) {
  const cand = [
    { d: "\t", n: (line.match(/\t/g) || []).length },
    { d: ",", n: (line.match(/,/g) || []).length },
    { d: ";", n: (line.match(/;/g) || []).length },
    { d: "，", n: (line.match(/，/g) || []).length }, // 全角カンマ
    { d: "、", n: (line.match(/、/g) || []).length }, // 和文読点
    { d: "|", n: (line.match(/\|/g) || []).length },
  ];
  cand.sort((a, b) => b.n - a.n);
  if (cand[0].n > 0) return { delim: cand[0].d, regex: new RegExp(`\\${cand[0].d}`) };
  // どれも見つからない場合はスペース2個以上を区切りにする
  return { delim: "WS", regex: /\s{2,}/ };
}

function norm(tok) {
  return String(tok || "")
    .replace(/^\uFEFF/, "")        // BOM
    .replace(/^["']|["']$/g, "")   // 先頭/末尾の引用符
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

// 英日/別名を正規化
function normalizeHeaderToken(tok) {
  const t = norm(tok);
  if (["week", "週", "第"].includes(t)) return "week";
  if (["day", "曜日"].includes(t)) return "day";
  if (["kind", "種別", "カテゴリ", "category"].includes(t)) return "kind";
  if (["slot", "スロット", "部位", "タイム"].includes(t)) return "slot";
  if (["text", "本文", "内容", "メニュー"].includes(t)) return "text";
  if (["calories", "kcal", "calories(kcal)", "calories (kcal)", "カロリー"].includes(t)) return "calories";
  if (["p", "protein", "タンパク質"].includes(t)) return "p";
  if (["f", "fat", "脂質"].includes(t)) return "f";
  if (["c", "carb", "carbs", "炭水化物"].includes(t)) return "c";
  if (["tips", "tip", "note", "notes", "メモ", "注意"].includes(t)) return "tips";
  return t;
}

const EXPECTED = ["week", "day", "kind", "slot", "text", "calories", "p", "f", "c", "tips"];

// 列名から「期待→実列index」マッピングを作る（順不同対応）
function buildHeaderMap(tokensRaw) {
  const map = new Map(); // 正規化名 -> index
  tokensRaw.forEach((t, i) => {
    const k = normalizeHeaderToken(t);
    if (!map.has(k)) map.set(k, i);
  });
  const essential = ["week", "day", "kind", "slot", "text"];
  const hasEssential = essential.every((k) => map.has(k));
  if (!hasEssential) return null;
  return EXPECTED.map((k) => (map.has(k) ? map.get(k) : -1));
}

// 行が（正規化後に）ヘッダー風かどうか
function looksLikeHeaderRow(cols, mapper) {
  if (!cols || cols.length < 2) return false;
  const a = norm(cols[mapper?.[0] ?? 0]);
  const b = norm(cols[mapper?.[1] ?? 1]);
  return (a === "week" || a === "day") && (b === "day" || b === "kind");
}

/* ================= CSV/TSV/WS クレンジング ================= */
function cleanseCsv(raw) {
  const csv = raw.replace(/^```[a-z]*\n?/i, "").replace(/\n?```$/, "").trim();
  const lines = csv.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (!lines.length) return { rows: [], delimInfo: { delim: ",", regex: /,/ }, mapper: null };

  const delimInfo = detectDelimiterFlexible(lines[0]);
  const headerRaw = lines[0].split(delimInfo.regex);
  const mapper = buildHeaderMap(headerRaw);

  if (!mapper) {
    console.warn("[cleanseCsv] header unresolved:", headerRaw);
    // フェールソフト：先頭5列を Week..Text とみなす暫定マッピングを作る
    const fallback = headerRaw.slice(0, 5).map((_, i) => i);
    while (fallback.length < EXPECTED.length) fallback.push(-1);
    return { rows: lines.slice(1), delimInfo, mapper: fallback };
  }

  // 本文抽出（二重ヘッダー掃除）
  const body = lines.slice(1).filter((line) => {
    const cols = line.split(delimInfo.regex);
    return !looksLikeHeaderRow(cols, mapper);
  });

  if (body.length !== 35) {
    console.warn(`[cleanseCsv] rows expected=35 actual=${body.length}`);
  }
  return { rows: body, delimInfo, mapper };
}

/* ================= 週次生成（Logs反映） ================= */
async function generateNextWeekWithGPT(getWeekAndDayJST) {
  const { week } = getWeekAndDayJST(process.env.START_DATE);
  const nextWeek = week + 1;

  const { sheet, rows, idx } = await loadMealPlan();
  const exists = rows.some((r) => String(r._rawData[idx.Week]).trim() === String(nextWeek));
  if (exists) return { created: 0, skipped: true, week: nextWeek };

  // 現週の簡易要約
  const thisWeekRows = rows.filter((r) => String(r._rawData[idx.Week]).trim() === String(week));
  const brief = thisWeekRows.slice(0, 50).map((r) => {
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
  }).join("\n");

  // 直近ログ（10日）
  const recentLogs = await getRecentLogs(10);
  const trainLogs = recentLogs.filter((x) => x.Kind === "Training");
  const mealLogs  = recentLogs.filter((x) => x.Kind === "Meal");
  const trainBrief = trainLogs.map((x) => `- ${x.Date} ${x.Slot}: ${x.Text}`).join("\n") || "- 直近トレ記録なし";
  const mealBrief  = mealLogs.slice(-7).map((x) => `- ${x.Date} ${x.Slot}: ${x.Text}`).join("\n");

  const prompt = `あなたは管理栄養士兼パーソナルトレーナーです。
28歳男性 170cm/80kg、減量フェーズ。好み：刺身中心、パプリカ/ピーマン不可。朝ジム。PFCは高タンパク・中〜低脂質・適量炭水化物。夜は糖質控えめ。

【直近のMealPlan（参考）】
Day|Kind|Slot|Text|kcal|P|F|C
${brief}

【直近の自由入力ログ（Training抜粋）】
${trainBrief}

【直近の自由入力ログ（Meal一部）】
${mealBrief}

次週（Week=${nextWeek}）の7日分（Meal: 朝/昼/夜/就寝、Training: ジム or 休養）を **CSV** で出力。
列は固定：Week,Day,Kind,Slot,Text,Calories,P,F,C,Tips

ルール：
- Dayは Mon,Tue,Wed,Thu,Fri,Sat,Sun
- Kindは Meal / Training
- Slotは Mealなら「朝/昼/夜/就寝」、Trainingなら「ジム」または「休養」
- Text/Tipsは日本語（**カンマは使わず**「・」等で表現）
- Calories,P,F,C は整数（空欄可だが原則入れる）
- 7日分の Meal(4×7=28) と Training(1×7=7) の合計35行
- 1行目は上記ヘッダー。以降に35行。
- **Training の Text は具体的な種目・回数/時間**（例：胸：ベンチ4x8・インクラインDB3x12・HIIT10分）
- 部位ローテーション（胸/背/脚/肩/腕/休養）
`;

  const res = await withBackoff(() =>
    openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.2,
      messages: [{ role: "user", content: prompt }],
    })
  );

  const raw = (res.choices?.[0]?.message?.content || "").trim();
  const { rows: filtered, delimInfo, mapper } = cleanseCsv(raw);

  const toInsert = [];
  for (const line of filtered) {
    const colsSrc = line.split(delimInfo.regex);

    // マッピングで期待順に並べ替え（欠損列は空文字）
    const cols = EXPECTED.map((_, i) => {
      const srcIdx = mapper[i];
      return srcIdx >= 0 ? (colsSrc[srcIdx] ?? "").trim() : "";
    });

    // 二重ヘッダー掃除
    if (looksLikeHeaderRow(cols, null)) continue;

    if (cols.length < 10) continue;
    const row = {
      Week: cols[0], Day: cols[1], Kind: cols[2], Slot: cols[3],
      Text: cols[4], Calories: cols[5], P: cols[6], F: cols[7], C: cols[8], Tips: cols[9],
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
