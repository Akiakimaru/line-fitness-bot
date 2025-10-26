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

/**
 * 汎用テキスト生成関数
 */
async function generateText(prompt, options = {}) {
  try {
    const response = await openai.chat.completions.create({
      model: options.model || "gpt-4o-mini",
      messages: [
        { role: "system", content: options.system || "あなたは有用なアシスタントです。" },
        { role: "user", content: prompt }
      ],
      temperature: options.temperature || 0.3,
      max_tokens: options.max_tokens || 2000
    });

    return response.choices?.[0]?.message?.content || "";
  } catch (error) {
    console.error('[generateText] Error:', error);
    throw error;
  }
}

/**
 * 週間ログをGPTで分析してフィードバックを生成
 */
async function generateWeeklyFeedback(userId, days = 7) {
  try {
    console.log(`[generateWeeklyFeedback] Analyzing logs for userId: ${userId}, days: ${days}`);
    
    // ログを取得してユーザーのものだけフィルタ
    const allLogs = await readRecentLogs(days);
    const userLogs = allLogs.filter(log => log.UserId === userId);
    
    if (userLogs.length === 0) {
      return "📊 記録が見つかりませんでした。\n\nLINE Botで食事・ジム・体重を記録すると、AIが週間フィードバックを提供します。";
    }
    
    // ログを種類別に集計
    const mealLogs = userLogs.filter(l => l.Kind === 'Meal');
    const gymLogs = userLogs.filter(l => l.Kind === 'Gym');
    const weightLogs = userLogs.filter(l => l.Kind === 'Weight');
    
    // 詳細な統計情報を作成
    let stats = {
      meals: mealLogs.length,
      gym: gymLogs.length,
      weights: weightLogs.length,
      totalLogs: userLogs.length
    };
    
    // 体重推移分析
    let weightAnalysis = "";
    if (weightLogs.length > 0) {
      const weights = weightLogs.map(l => ({
        value: parseFloat(l.Text),
        time: new Date(l.DateTime)
      })).filter(w => !isNaN(w.value)).sort((a, b) => a.time - b.time);
      
      if (weights.length > 0) {
        const latest = weights[weights.length - 1].value;
        const earliest = weights[0].value;
        const change = latest - earliest;
        const avg = weights.reduce((sum, w) => sum + w.value, 0) / weights.length;
        
        weightAnalysis = `体重記録: ${weights.length}回\n最新: ${latest.toFixed(1)}kg・平均: ${avg.toFixed(1)}kg・変化: ${change > 0 ? '+' : ''}${change.toFixed(1)}kg`;
      }
    } else {
      weightAnalysis = "体重記録: なし";
    }
    
    // 食事分析（PFC含む）
    let mealAnalysis = "";
    if (mealLogs.length > 0) {
      let totalP = 0, totalF = 0, totalC = 0, totalCal = 0, pfcCount = 0;
      const mealTimes = {};
      
      mealLogs.forEach(log => {
        // 時刻分析
        const time = new Date(log.DateTime);
        const hour = time.getHours();
        const timeSlot = hour < 10 ? '朝' : hour < 15 ? '昼' : hour < 20 ? '夕' : '夜';
        mealTimes[timeSlot] = (mealTimes[timeSlot] || 0) + 1;
        
        // PFC分析
        if (log.PFC && log.PFC.total) {
          totalP += log.PFC.total.protein || 0;
          totalF += log.PFC.total.fat || 0;
          totalC += log.PFC.total.carbs || 0;
          totalCal += log.PFC.total.calories || 0;
          pfcCount++;
        }
      });
      
      const timeDistribution = Object.entries(mealTimes)
        .map(([slot, count]) => `${slot}${count}回`)
        .join('・');
      
      mealAnalysis = `食事記録: ${mealLogs.length}回（${timeDistribution}）`;
      if (pfcCount > 0) {
        const avgP = (totalP / pfcCount).toFixed(0);
        const avgF = (totalF / pfcCount).toFixed(0);
        const avgC = (totalC / pfcCount).toFixed(0);
        const avgCal = (totalCal / pfcCount).toFixed(0);
        mealAnalysis += `\nPFC平均: P${avgP}g・F${avgF}g・C${avgC}g・${avgCal}kcal/食`;
      }
    } else {
      mealAnalysis = "食事記録: なし";
    }
    
    // トレーニング分析
    let gymAnalysis = "";
    if (gymLogs.length > 0) {
      let totalSets = 0, totalMinutes = 0;
      const exercises = new Map();
      
      gymLogs.forEach(log => {
        if (log.Meta && Array.isArray(log.Meta.parsed)) {
          log.Meta.parsed.forEach(ex => {
            exercises.set(ex.name, (exercises.get(ex.name) || 0) + 1);
            if (Array.isArray(ex.sets)) totalSets += ex.sets.length;
            if (ex.minutes) totalMinutes += ex.minutes;
          });
        }
      });
      
      const topExercises = Array.from(exercises.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([name, count]) => `${name}×${count}`)
        .join('・') || "-";
      
      gymAnalysis = `トレーニング記録: ${gymLogs.length}回\n合計セット数: ${totalSets}・有酸素: ${totalMinutes}分\n主要種目: ${topExercises}`;
    } else {
      gymAnalysis = "トレーニング記録: なし";
    }
    
    // ログの詳細テキストを生成（GPTに渡す用）
    const logDetails = userLogs.slice(0, 50).map(log => {
      const time = new Date(log.DateTime);
      const timeStr = `${time.getMonth()+1}/${time.getDate()} ${time.getHours()}:${String(time.getMinutes()).padStart(2, '0')}`;
      let detail = `[${timeStr}] ${log.Kind}: ${log.Text}`;
      
      if (log.Kind === 'Meal' && log.PFC && log.PFC.total) {
        const p = log.PFC.total;
        detail += ` (P${p.protein}g F${p.fat}g C${p.carbs}g ${p.calories}kcal)`;
      }
      
      return detail;
    }).join('\n');
    
    // GPTへのシステムプロンプト
    const systemPrompt = `あなたは、科学的根拠に基づくパーソナルトレーナー兼管理栄養士です。
役割は、ユーザーの健康状態・記録ログ・体重推移を踏まえ、的確なフィードバックを提供することです。

【専門性】
- 管理栄養士（栄養学・PFCバランス設計）
- パーソナルトレーナー（筋肥大・減量プログラミング）
- スポーツ科学（疲労回復・オーバートレーニング防止）
- 行動科学（無理のない継続設計）
- データリーダー（記録の解析と傾向抽出）

【人格・スタイル】
- 冷静かつ科学的・客観的。根拠を前提に提案。
- 不必要な感情語は使わず、行動可能な指示を出す。
- 食材・トレーニングは「現実に日本のスーパー／一般ジムで実践可能な内容」を前提とする。
- 可読性重視。カンマではなく中黒「・」を使用。
- LINE表示を考慮し、簡潔で構造化された出力（絵文字活用）。

【ユーザー情報】
- 28歳男性・170cm・80kg前後・減量目標
- 高タンパク・中〜低脂質・適量炭水化物を志向
- 刺身中心・オートミール少量・パプリカ/ピーマン不可
- 朝ジム派

【出力形式】
1. 総合評価（一言）
2. 良かった点（2-3個）
3. 改善提案（2-3個、優先度順）
4. 来週のアクションプラン（具体的）

**重要**: ログの入力時間が各項目の実施時間です。食事時刻・トレーニング時刻を考慮してください。`;

    const userPrompt = `【分析期間】
過去${days}日間の記録

【統計サマリー】
${weightAnalysis}
${mealAnalysis}
${gymAnalysis}

【詳細ログ（新しい順、最大50件）】
${logDetails}

上記のデータを分析し、科学的根拠に基づいた週間フィードバックを提供してください。`;

    console.log(`[generateWeeklyFeedback] Calling GPT with ${userLogs.length} logs`);
    
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ],
      temperature: 0.4,
      max_tokens: 1500
    });
    
    const feedback = response.choices?.[0]?.message?.content || "フィードバックの生成に失敗しました。";
    
    console.log(`[generateWeeklyFeedback] Generated feedback length: ${feedback.length}`);
    
    return `📊 週間フィードバック（過去${days}日間）\n\n${feedback}`;
    
  } catch (error) {
    console.error('[generateWeeklyFeedback] Error:', error);
    throw new Error(`フィードバック生成エラー: ${error.message}`);
  }
}

/**
 * JSONを抽出する（コードフェンス除去）
 */
function extractJsonBody(raw) {
  if (!raw) return null;
  let txt = String(raw).trim();
  
  // コードフェンスを除去（```json ... ``` または ``` ... ```）
  // 最初の ```json または ``` を探す
  if (txt.startsWith('```')) {
    // 最初の改行までを削除
    const firstNewline = txt.indexOf('\n');
    if (firstNewline !== -1) {
      txt = txt.substring(firstNewline + 1);
    }
    // 最後の ``` を削除
    const lastFence = txt.lastIndexOf('```');
    if (lastFence !== -1) {
      txt = txt.substring(0, lastFence);
    }
    txt = txt.trim();
  }
  
  // JSONとしてパース
  try {
    return JSON.parse(txt);
  } catch (e) {
    console.error('[extractJsonBody] JSON parse error:', e.message);
    console.error('[extractJsonBody] First 200 chars:', txt.substring(0, 200));
    return null;
  }
}

/**
 * 買い出し計画を生成
 */
async function generateShoppingPlan(userId, userInput = {}) {
  try {
    console.log(`[generateShoppingPlan] Generating plan for userId: ${userId}`);
    
    // ユーザーの過去ログを分析（体重推移・嗜好・パターン）
    const allLogs = await readRecentLogs(14); // 過去2週間
    const userLogs = allLogs.filter(log => log.UserId === userId);
    
    // 体重の最新値を取得
    const weightLogs = userLogs.filter(l => l.Kind === 'Weight');
    let currentWeight = 80; // デフォルト
    if (weightLogs.length > 0) {
      const latest = weightLogs
        .map(l => ({ value: parseFloat(l.Text), time: new Date(l.DateTime) }))
        .filter(w => !isNaN(w.value))
        .sort((a, b) => b.time - a.time)[0];
      if (latest) currentWeight = latest.value;
    }
    
    // 食事ログから嗜好を抽出
    const mealLogs = userLogs.filter(l => l.Kind === 'Meal');
    const foodFrequency = new Map();
    mealLogs.forEach(log => {
      const foods = log.Text.split(/[・、,\/\n\s]+/).filter(f => f.trim().length > 1);
      foods.forEach(food => {
        const normalized = food.trim().replace(/\d+g|\d+ml|\d+個|\d+本|\d+袋/g, '').trim();
        if (normalized) {
          foodFrequency.set(normalized, (foodFrequency.get(normalized) || 0) + 1);
        }
      });
    });
    
    const topFoods = Array.from(foodFrequency.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([food, count]) => `${food}(${count}回)`)
      .join('・') || "データ不足";
    
    // ジムログからトレーニング頻度を推定
    const gymLogs = userLogs.filter(l => l.Kind === 'Gym');
    const gymDaysPerWeek = Math.min(7, Math.max(3, Math.round(gymLogs.length / 2))); // 週3-7回
    
    // システムプロンプト
    const systemPrompt = `あなたは、減量期の食事運用を支援する週間メニュー＆買い出し計画ジェネレーターです。
ユーザーは日本語で条件を入力します。あなたは以下仕様に基づき、厳密にJSONだけを出力してください。説明文は一切不要です。

【最優先事項：バラエティ豊かな週間メニューの作成】
まず、飽きのこない多様な食事メニューを1週間分（月〜日）設計してください。
その後、そのメニューに必要な食材を集計して買い出しリストを作成してください。

【メニュー設計の原則】
1. **毎日異なる味付け・調理法**を採用（塩麹→ポン酢→カレー粉→味噌→照り焼き→トマト煮→和風だし）
2. **たんぱく質源のローテーション**：
   - 月：鶏むね肉
   - 火：卵＋納豆
   - 水：鮭
   - 木：鶏もも肉
   - 金：豚ヒレ肉
   - 土：サバ
   - 日：豆腐＋卵
3. **野菜も多様に**：キャベツ、ブロッコリー、ほうれん草、トマト、にんじん、もやし、きのこ類など
4. **同じメニューの連続を避ける**：2日連続で同じ主菜は禁止
5. **調理時間は10分以内**、または作り置きで対応

【ユーザー情報】
- 体重：${currentWeight}kg → 目標70kg
- 目的：減量（筋量維持優先）
- トレ頻度：週${gymDaysPerWeek}回
- ジム時間帯：不規則（早朝・夕方・夜）
- 買い出し頻度：週2回（火曜夜・土曜午前）
- PFC目安（トレ日）：P 160g / F 50g / C 200g / 1,950–2,100kcal
- 非トレ日：C −30〜50g、他は同等
- 過去の頻出食材：${topFoods}

【出力要件】
1. **まず週間メニュー（weekly_menu）を作成**：朝・昼・夜の3食×7日分
2. **次に買い出しリスト（shopping_plan）を作成**：週間メニューで使う全食材を集計
3. 買い出しは2回に分割：
   - trip_1（火曜夜）：火〜金曜分の食材
   - trip_2（土曜午前）：土〜月曜分の食材
4. 作り置きレシピ（batch_cook）も含める
5. **すべての内容は日本語で記述**

【固定の調味料（標準在庫）】
塩麹、減塩しょうゆ、味噌、ポン酢、はちみつ、鶏がらスープ顆粒、コンソメ、ブラックペッパー、一味/七味、にんにくチューブ、オリーブオイル、MCT

【重要】
- **JSONのみ**を出力。前置きや説明文は不要。
- コードフェンス（\`\`\`json）で囲んでも可。`;

    const userPrompt = `現在の体重: ${currentWeight}kg
トレーニング頻度: 週${gymDaysPerWeek}回
過去2週間の頻出食材: ${topFoods}

上記を踏まえ、**飽きのこない週間メニュー**と**買い出し計画**をJSONで生成してください。
以下のスキーマに厳密に従ってください：

**重要：すべての食材名・手順・メモは日本語で記述してください。**

{
  "plan_meta": {
    "goal": "cut",
    "gym_frequency": ${gymDaysPerWeek},
    "shopping_frequency": 2,
    "batch_cook_days": ["火曜夜", "日曜午後"],
    "pfc_target": { "protein_g": 160, "fat_g": 50, "carb_g": 200, "kcal": 2000 }
  },
  "weekly_menu": {
    "Mon": {
      "breakfast": {
        "menu_name": "オートミール＋卵＋納豆",
        "main_protein": "卵・納豆",
        "ingredients": ["オートミール30g", "卵2個", "納豆1パック", "ほうれん草30g"],
        "cooking_method": "レンジ調理",
        "cooking_time": "5分",
        "pfc": { "protein_g": 25, "fat_g": 12, "carb_g": 35 }
      },
      "lunch": {
        "menu_name": "鶏むね塩麹焼き＋玄米＋野菜",
        "main_protein": "鶏むね肉",
        "ingredients": ["鶏むね肉150g", "玄米200g", "キャベツ100g"],
        "cooking_method": "作り置き使用",
        "cooking_time": "2分（温め）",
        "pfc": { "protein_g": 45, "fat_g": 8, "carb_g": 70 }
      },
      "dinner": {
        "menu_name": "鮭のポン酢焼き＋豆腐＋ブロッコリー",
        "main_protein": "鮭",
        "ingredients": ["鮭1切れ150g", "木綿豆腐100g", "ブロッコリー100g"],
        "cooking_method": "グリル＋レンジ",
        "cooking_time": "8分",
        "pfc": { "protein_g": 50, "fat_g": 15, "carb_g": 20 }
      }
    },
    "Tue": {
      "breakfast": { /* 月曜と異なる内容 */ },
      "lunch": { /* 月曜と異なる内容 */ },
      "dinner": { /* 月曜と異なる内容 */ }
    },
    "Wed": { /* 火曜と異なる内容 */ },
    "Thu": { /* 水曜と異なる内容 */ },
    "Fri": { /* 木曜と異なる内容 */ },
    "Sat": { /* 金曜と異なる内容 */ },
    "Sun": { /* 土曜と異なる内容 */ }
  },
  "shopping_plan": {
    "trip_1": { 
      "when": "火曜夜", 
      "for_days": ["火", "水", "木", "金"],
      "items": [
        { "category": "たんぱく質", "name": "鶏むね肉", "quantity": "600g", "used_in": ["火昼", "水夜"], "alt": ["鶏もも肉", "豚ヒレ肉"] },
        { "category": "たんぱく質", "name": "卵", "quantity": "10個", "used_in": ["火朝", "水朝", "木朝", "金朝"], "alt": ["液状卵白"] }
      ]
    },
    "trip_2": { 
      "when": "土曜午前", 
      "for_days": ["土", "日", "月"],
      "items": [
        { "category": "魚", "name": "鮭", "quantity": "3切れ", "used_in": ["土夜", "月昼"], "alt": ["サバ"] }
      ]
    },
    "seasonings_needed": [
      { "name": "塩麹", "have": false },
      { "name": "ポン酢", "have": true }
    ]
  },
  "batch_cook": [
    {
      "when": "火曜夜",
      "recipes": [
        {
          "title": "鶏むね塩麹焼き",
          "servings": 4,
          "for_days": ["水昼", "木昼"],
          "ingredients": [{ "name": "鶏むね肉", "qty": "500g" }, { "name": "塩麹", "qty": "大さじ2" }],
          "steps": ["塩麹で30分下味", "フライパンで片面4分ずつ焼く"],
          "store": { "method": "冷蔵", "days": 3 }
        }
      ]
    }
  ],
  "notes": [
    "毎日異なるたんぱく質源を使用",
    "同じ味付けの連続を避ける",
    "野菜は5種類以上ローテーション"
  ]
}`;

    console.log(`[generateShoppingPlan] Calling GPT...`);
    
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ],
      temperature: 0.3,
      max_tokens: 8000  // 週間メニュー全体を生成するため増やす
    });
    
    const rawContent = response.choices?.[0]?.message?.content || "";
    console.log(`[generateShoppingPlan] Raw response length: ${rawContent.length}`);
    
    // JSONを抽出
    const planJson = extractJsonBody(rawContent);
    
    if (!planJson) {
      throw new Error('GPTからのJSON抽出に失敗しました');
    }
    
    // 必須キーの検証（weekly_menuを追加、day_scheduleは削除）
    const requiredKeys = ['plan_meta', 'weekly_menu', 'shopping_plan', 'batch_cook'];
    for (const key of requiredKeys) {
      if (!planJson[key]) {
        throw new Error(`必須キー "${key}" が見つかりません`);
      }
    }
    
    console.log(`[generateShoppingPlan] Plan generated successfully`);
    
    return planJson;
    
  } catch (error) {
    console.error('[generateShoppingPlan] Error:', error);
    throw new Error(`買い出し計画生成エラー: ${error.message}`);
  }
}

/**
 * 買い出し計画を要約してLINE表示用テキストに変換
 */
function formatShoppingPlanForLine(planJson) {
  try {
    const meta = planJson.plan_meta || {};
    const shopping = planJson.shopping_plan || {};
    const batchCook = planJson.batch_cook || [];
    const weeklyMenu = planJson.weekly_menu || {};
    
    let text = `📋 今週の買い出し計画＆メニュー\n\n`;
    
    // 目標サマリー
    text += `🎯 目標：減量（筋量維持）\n`;
    text += `💪 トレーニング：週${meta.gym_frequency || 5}回\n`;
    if (meta.pfc_target) {
      const pfc = meta.pfc_target;
      text += `📊 PFC目標：P${pfc.protein_g}g・F${pfc.fat_g}g・C${pfc.carb_g}g・${pfc.kcal}kcal\n`;
    }
    text += `\n`;
    
    // 週間メニューのハイライト（たんぱく質源のローテーション）
    if (Object.keys(weeklyMenu).length > 0) {
      text += `🍽️ 今週のメイン食材\n`;
      const dayNames = { Mon: '月', Tue: '火', Wed: '水', Thu: '木', Fri: '金', Sat: '土', Sun: '日' };
      const proteins = [];
      Object.entries(weeklyMenu).forEach(([day, meals]) => {
        if (meals.dinner && meals.dinner.main_protein) {
          proteins.push(`${dayNames[day]}:${meals.dinner.main_protein}`);
        }
      });
      text += proteins.slice(0, 7).join('・') + `\n\n`;
    }
    
    // 買い出し1回目
    if (shopping.trip_1) {
      const trip1 = shopping.trip_1;
      text += `🛒 ${trip1.when}の買い物\n`;
      const categories = {};
      (trip1.items || []).forEach(item => {
        const cat = item.category || 'その他';
        if (!categories[cat]) categories[cat] = [];
        categories[cat].push(`${item.name} ${item.quantity}`);
      });
      
      Object.entries(categories).forEach(([cat, items]) => {
        text += `・${cat}: ${items.slice(0, 3).join('・')}`;
        if (items.length > 3) text += `ほか${items.length - 3}品`;
        text += `\n`;
      });
      text += `（計${trip1.items?.length || 0}品）\n\n`;
    }
    
    // 買い出し2回目
    if (shopping.trip_2) {
      const trip2 = shopping.trip_2;
      text += `🛒 ${trip2.when}の買い物\n`;
      const categories = {};
      (trip2.items || []).forEach(item => {
        const cat = item.category || 'その他';
        if (!categories[cat]) categories[cat] = [];
        categories[cat].push(`${item.name} ${item.quantity}`);
      });
      
      Object.entries(categories).forEach(([cat, items]) => {
        text += `・${cat}: ${items.slice(0, 3).join('・')}`;
        if (items.length > 3) text += `ほか${items.length - 3}品`;
        text += `\n`;
      });
      text += `（計${trip2.items?.length || 0}品）\n\n`;
    }
    
    // 作り置き予定
    text += `🍳 作り置き予定\n`;
    batchCook.forEach(batch => {
      const recipes = batch.recipes || [];
      const recipeNames = recipes.map(r => r.title).join('・');
      text += `${batch.when}: ${recipeNames}\n`;
    });
    text += `\n`;
    
    // 注意事項
    if (planJson.notes && planJson.notes.length > 0) {
      text += `💡 ポイント\n`;
      planJson.notes.slice(0, 3).forEach(note => {
        text += `・${note}\n`;
      });
    }
    
    return text;
    
  } catch (error) {
    console.error('[formatShoppingPlanForLine] Error:', error);
    return '買い出し計画の整形に失敗しました。';
  }
}

/**
 * 買い出し計画から食材リストを抽出
 */
function extractIngredientsFromShoppingPlan(planJson) {
  if (!planJson || !planJson.shopping_plan) return [];
  
  const ingredients = [];
  
  // trip_1 と trip_2 の食材を統合
  const trips = [planJson.shopping_plan.trip_1, planJson.shopping_plan.trip_2];
  
  trips.forEach(trip => {
    if (trip && trip.items) {
      trip.items.forEach(item => {
        ingredients.push({
          category: item.category || 'その他',
          name: item.name,
          quantity: item.quantity,
          alt: item.alt || []
        });
      });
    }
  });
  
  return ingredients;
}

/**
 * 日次メニューを生成（買い出し計画ベース）
 * 週間メニューがあればそこから取得、なければGPTで生成
 */
async function generateDailyMenuWithRecipe(userId, date, slot, shoppingPlan) {
  try {
    console.log(`[generateDailyMenuWithRecipe] Generating menu for ${userId}, ${date}, ${slot}`);
    
    // 週間メニューをチェック
    const weeklyMenu = shoppingPlan.planJson?.weekly_menu;
    if (weeklyMenu) {
      // 曜日を判定（dateから）
      const dateObj = new Date(date);
      const dayOfWeek = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][dateObj.getDay()];
      
      const dayMenu = weeklyMenu[dayOfWeek];
      if (dayMenu && dayMenu[slot]) {
        const menuData = dayMenu[slot];
        console.log(`[generateDailyMenuWithRecipe] Using weekly menu: ${menuData.menu_name}`);
        
        // 週間メニューの形式を日次メニューの形式に変換
        return {
          menuName: menuData.menu_name,
          ingredients: menuData.ingredients.map(ing => {
            // "オートミール30g" → { name: "オートミール", quantity: "30", unit: "g" }
            const match = ing.match(/^(.+?)(\d+)(g|ml|個|切れ|パック|本|袋)?$/);
            if (match) {
              return { name: match[1], quantity: match[2], unit: match[3] || '' };
            }
            return { name: ing, quantity: '', unit: '' };
          }),
          recipe: [
            `調理方法: ${menuData.cooking_method}`,
            `調理時間: ${menuData.cooking_time}`
          ],
          cookingTime: parseInt(menuData.cooking_time) || 10,
          pfc: {
            protein: menuData.pfc?.protein_g || 0,
            fat: menuData.pfc?.fat_g || 0,
            carbs: menuData.pfc?.carb_g || 0,
            calories: (menuData.pfc?.protein_g || 0) * 4 + (menuData.pfc?.fat_g || 0) * 9 + (menuData.pfc?.carb_g || 0) * 4
          },
          tips: `主なたんぱく質: ${menuData.main_protein}`
        };
      }
    }
    
    console.log(`[generateDailyMenuWithRecipe] Weekly menu not found, generating with GPT...`);
    
    // 週間メニューがない場合はGPTで生成（従来の方法）
    const availableIngredients = extractIngredientsFromShoppingPlan(shoppingPlan.planJson);
    
    if (availableIngredients.length === 0) {
      throw new Error('買い出し計画に食材が見つかりません');
    }
    
    // 食材リストを整形
    const ingredientsList = availableIngredients
      .map(ing => `${ing.name}（${ing.quantity}）`)
      .join('、');
    
    // slotを日本語に変換
    const slotJp = {
      'breakfast': '朝食',
      'lunch': '昼食',
      'dinner': '夕食',
      'snack': '間食'
    }[slot] || slot;
    
    const systemPrompt = `あなたは、買い出し計画に基づいた食事メニューと調理手順を提案する料理アシスタントです。

【役割】
- 利用可能な食材リストから、最適なメニューを提案
- 10分以内で調理可能な手順を明示
- PFCバランスを考慮（減量期・高たんぱく重視）
- 実用的で再現性の高いレシピ

【出力形式】
JSON形式で以下を含める：
{
  "menuName": "メニュー名（日本語）",
  "ingredients": [
    { "name": "食材名", "quantity": "数量", "unit": "単位" }
  ],
  "recipe": [
    "手順1（簡潔に）",
    "手順2（簡潔に）",
    "手順3（簡潔に）"
  ],
  "cookingTime": 調理時間（分）,
  "pfc": { "protein": P, "fat": F, "carbs": C, "calories": kcal },
  "tips": "調理のコツ（1文）"
}

【重要】
- すべて日本語で記述
- 調理時間は10分以内
- 手順は3-5ステップに簡潔化
- 既製品（納豆・R1・パルテノ等）は「用意する」でOK`;

    const userPrompt = `日付: ${date}
食事枠: ${slotJp}
利用可能な食材: ${ingredientsList}

上記の食材を使って、${slotJp}に適したメニューを1つ提案してください。
調理手順は簡潔に、10分以内で完成するものをお願いします。

【追加条件】
- 朝食: 高たんぱく + 適量炭水化物、消化に良いもの
- 昼食: バランス重視、作り置き活用OK
- 夕食: 高たんぱく・低脂質、炭水化物控えめ`;

    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ],
      temperature: 0.4,
      max_tokens: 1000
    });

    const rawContent = response.choices[0].message.content;
    const menuJson = extractJsonBody(rawContent);
    
    if (!menuJson) {
      throw new Error('GPTからのJSON抽出に失敗しました');
    }
    
    // 必須キーの検証
    const requiredKeys = ['menuName', 'ingredients', 'recipe', 'cookingTime', 'pfc'];
    for (const key of requiredKeys) {
      if (!menuJson[key]) {
        throw new Error(`必須キー "${key}" が見つかりません`);
      }
    }
    
    console.log(`[generateDailyMenuWithRecipe] Generated menu: ${menuJson.menuName}`);
    
    return menuJson;
    
  } catch (error) {
    console.error('[generateDailyMenuWithRecipe] Error:', error);
    throw new Error(`日次メニュー生成エラー: ${error.message}`);
  }
}

/**
 * 日次メニューをLINE表示用テキストに整形
 */
function formatDailyMenuForLine(menu, mealTime) {
  try {
    const slotEmoji = {
      'breakfast': '🍳',
      'lunch': '🍱',
      'dinner': '🍽',
      'snack': '🍪'
    };
    
    const emoji = slotEmoji[menu.slot] || '🍽';
    
    let text = `${emoji} 今日の${menu.slot === 'breakfast' ? '朝食' : menu.slot === 'lunch' ? '昼食' : menu.slot === 'dinner' ? '夕食' : '間食'}（${mealTime}）\n\n`;
    
    // メニュー名
    text += `【メニュー】\n${menu.menuName}\n\n`;
    
    // 材料
    if (menu.ingredients && menu.ingredients.length > 0) {
      text += `【材料】\n`;
      menu.ingredients.forEach(ing => {
        text += `・${ing.name} ${ing.quantity}${ing.unit || ''}\n`;
      });
      text += `\n`;
    }
    
    // 作り方
    if (menu.recipe) {
      const recipeSteps = Array.isArray(menu.recipe) ? menu.recipe : [menu.recipe];
      text += `【作り方（調理時間: ${menu.cookingTime || '?'}分）】\n`;
      recipeSteps.forEach((step, i) => {
        text += `${i + 1}. ${step}\n`;
      });
      text += `\n`;
    }
    
    // 栄養情報
    if (menu.pfc) {
      const pfc = menu.pfc;
      text += `【栄養情報】\n`;
      text += `P: ${pfc.protein || 0}g / F: ${pfc.fat || 0}g / C: ${pfc.carbs || 0}g / ${pfc.calories || 0}kcal\n\n`;
    }
    
    // コツ
    if (menu.tips) {
      text += `💡 ${menu.tips}`;
    }
    
    return text;
    
  } catch (error) {
    console.error('[formatDailyMenuForLine] Error:', error);
    return '日次メニューの整形に失敗しました。';
  }
}

module.exports = { 
  generateNextWeekWithGPT,
  generateText,
  generateWeeklyFeedback,
  generateShoppingPlan,
  formatShoppingPlanForLine,
  generateDailyMenuWithRecipe,
  formatDailyMenuForLine,
  extractIngredientsFromShoppingPlan
};
