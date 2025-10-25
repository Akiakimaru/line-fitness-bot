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
  const txt = String(raw).trim();
  
  // コードフェンス内のJSONを探す
  const fenceMatch = txt.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) {
    try {
      return JSON.parse(fenceMatch[1].trim());
    } catch (e) {
      console.error('[extractJsonBody] JSON parse error in fence:', e.message);
    }
  }
  
  // フェンスなしでそのままJSONとしてパース
  try {
    return JSON.parse(txt);
  } catch (e) {
    console.error('[extractJsonBody] JSON parse error:', e.message);
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
    const systemPrompt = `あなたは、減量期の食事運用を支援する買い出し計画ジェネレーターです。
ユーザーは日本語で条件を入力します。あなたは以下仕様に基づき、厳密にJSONだけを出力してください。説明文は一切不要です。

【目的】
「早朝ジム型」「料理時間が少ない」「週2回の買い出し」「作り置き活用」を前提に、現実的で継続可能な買い出しリストと日次運用（食事・調理・ジム）を自動生成する。

【前提（デフォルト値）】
- 体重：${currentWeight}kg → 目標70kg
- 目的：減量（筋量維持優先）
- トレ頻度：週${gymDaysPerWeek}回（Push/Pull/Leg/Mix/Cardio or Rest）
- ジム時間帯：不規則（早朝・夕方・夜）※プッシュ通知は毎朝5時
- 買い出し頻度：週2回（火曜夜・土曜午前）
- 作り置き頻度：週2回（火曜夜・日曜午後）
- 1食あたり調理時間：10分以内、作り置きは各回40分以内
- PFC目安（トレ日）：P 160g / F 50g / C 200g / 1,950–2,100kcal
- 非トレ日：C −30〜50g、他は同等
- 嗜好・制限：過去の頻出食材は「${topFoods}」

【出力要件】
1. JSONのみを返す。キー順は任意だが、各キーは必須。
2. 単位の原則：g, 個, 袋, 本, パック, 切れ, 食（玄米パック等）。
3. 分量は1週間分を基準に在庫差分込みで提案。
4. 代替案を必ず付与（在庫・価格・売り切れ時の置換）。
5. 作り置きレシピは材料・分量・手順・保存方法（冷蔵/冷凍・日数）を含む。
6. タイムスケジュールは「起床→朝食→昼→間食→夕食→就寝」の時系列。ジム時間は不規則のため含めない。
7. 調味料は重複購入を回避し、在庫の有無で差分計算。
8. 説明文やマークダウンは一切出力しない。
9. **すべての内容は日本語で記述**。キー名は英語だが、値（食材名・手順・メモ等）は日本語。

【固定の調味料（標準在庫）】
塩麹、減塩しょうゆ、味噌、ポン酢、はちみつ、鶏がらスープ顆粒、コンソメ、ブラックペッパー、一味/七味、にんにくチューブ、オリーブオイル or MCT（加熱不可）

【食材テンプレート（頻出）】
- たんぱく質：鶏むね、鶏もも、鮭/サバ、卵、納豆、木綿豆腐、パルテノ無糖、プロテイン、EAA
- 主食：玄米パック、オートミール、もち麦おにぎり（代替）
- 野菜：キャベツ、もやし、えのき、ブロッコリー、にんじん（冷凍優先）
- 補助：R1、素焼きナッツ、はちみつ、MCT

【メニュー原則（短時間・再現性）】
- 味付けは「塩麹／ポン酢／カレー粉」を軸に週ローテ。
- 作り置き：
  - 火曜夜：鶏むね塩麹焼き／鶏もも照り焼き／煮卵／玄米小分け
  - 日曜午後：鮭 or サバ塩焼き／野菜レンチンミックス／鶏むね下味冷凍
- 平日夜は低脂質・高たんぱくを徹底。
- トレ後：パルテノ＋はちみつ＋プロテイン（速吸収＋糖補給、夜は無糖）

【バリデーション】
- 合計PFC推定が目標から大きく外れないこと（±10%以内を努力目標）。
- 各メニューの手順は10分以内で完結するか、作り置きで完了すること。
- 買い出し回数・作り置き回数は週2固定。
- 在庫がある品目は購入数を自動減算。
- 代替案の提示は全カテゴリで最低1つ。

【重要】
- **JSONのみ**を出力。前置きや説明文は不要。
- コードフェンス（\`\`\`json）で囲んでも可。`;

    const userPrompt = `現在の体重: ${currentWeight}kg
トレーニング頻度: 週${gymDaysPerWeek}回
過去2週間の頻出食材: ${topFoods}

上記を踏まえ、今週の買い出し計画をJSONで生成してください。
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
  "shopping_plan": {
    "trip_1": { 
      "when": "火曜夜", 
      "items": [
        { "category": "たんぱく質", "name": "鶏むね肉", "quantity": "1000g", "use": "作り置きと夕食", "alt": ["豚ヒレ肉", "木綿豆腐"] }
      ]
    },
    "trip_2": { 
      "when": "土曜午前", 
      "items": [
        { "category": "魚", "name": "鮭", "quantity": "2切れ", "use": "夕食", "alt": ["サバ"] }
      ]
    },
    "seasonings_needed": [
      { "name": "塩麹", "have": false },
      { "name": "減塩しょうゆ", "have": true }
    ]
  },
  "batch_cook": [
    {
      "when": "火曜夜",
      "recipes": [
        {
          "title": "鶏むね塩麹焼き",
          "servings": 4,
          "ingredients": [
            { "name": "鶏むね肉", "qty": "500g" },
            { "name": "塩麹", "qty": "大さじ2" }
          ],
          "steps": ["30分漬け込む", "中火で両面8分焼く", "休ませてスライス"],
          "store": { "method": "冷蔵", "days": 3 }
        }
      ]
    }
  ],
  "day_schedule": {
    "wake": "05:30 水500ml + EAA 13g",
    "breakfast": "08:00 オートミール30g + 卵2個 + 納豆 + 味噌汁",
    "lunch": "12:00 作り置きの鶏肉 + 玄米200g + 野菜",
    "snack": "15:30 ナッツ or R1",
    "dinner": "19:00 低脂質タンパク質 + 豆腐 + 野菜; 玄米150-200g（トレ日のみ）",
    "sleep": "23:00"
  },
  "notes": [
    "調理時間は1食10分以内を目安に、作り置きを活用",
    "夜のパルテノは無糖、はちみつはトレ後のみ",
    "非トレ日は炭水化物を30-50g減らす"
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
      max_tokens: 3000
    });
    
    const rawContent = response.choices?.[0]?.message?.content || "";
    console.log(`[generateShoppingPlan] Raw response length: ${rawContent.length}`);
    
    // JSONを抽出
    const planJson = extractJsonBody(rawContent);
    
    if (!planJson) {
      throw new Error('GPTからのJSON抽出に失敗しました');
    }
    
    // 必須キーの検証
    const requiredKeys = ['plan_meta', 'shopping_plan', 'batch_cook', 'day_schedule'];
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
    
    let text = `📋 今週の買い出し計画\n\n`;
    
    // 目標サマリー
    text += `🎯 目標：減量（筋量維持）\n`;
    text += `💪 トレーニング：週${meta.gym_frequency || 5}回\n`;
    if (meta.pfc_target) {
      const pfc = meta.pfc_target;
      text += `📊 PFC目標：P${pfc.protein_g}g・F${pfc.fat_g}g・C${pfc.carb_g}g・${pfc.kcal}kcal\n`;
    }
    text += `\n`;
    
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

module.exports = { 
  generateNextWeekWithGPT,
  generateText,
  generateWeeklyFeedback,
  generateShoppingPlan,
  formatShoppingPlanForLine
};
