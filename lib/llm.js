// lib/llm.js
const OpenAI = require("openai");
const { withBackoff } = require("./utils");
const { loadMealPlan, getRecentLogs, chunkAddRows } = require("./sheets");

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/* ========== 区切り & ヘッダー正規化ユーティリティ ========== */
function detectDelimiterCandidates(line) {
  return [
    { key: "\\t", regex: /\t/, count: (line.match(/\t/g) || []).length },
    { key: ",",  regex: /,/,  count: (line.match(/,/g)  || []).length },
    { key: ";",  regex: /;/,  count: (line.match(/;/g)  || []).length },
    { key: "，", regex: /，/, count: (line.match(/，/g) || []).length },
    { key: "、", regex: /、/, count: (line.match(/、/g) || []).length },
    { key: "\\|",regex: /\|/, count: (line.match(/\|/g) || []).length },
  ].sort((a,b)=>b.count-a.count);
}
const EXPECTED = ["week","day","kind","slot","text","calories","p","f","c","tips"];

const norm = (s) => String(s||"")
  .replace(/^\uFEFF/, "")
  .replace(/^["']|["']$/g, "")
  .trim()
  .replace(/\s+/g," ")
  .toLowerCase();

function normalizeHeaderToken(tok){
  const t = norm(tok);
  if (["week","週","第"].includes(t)) return "week";
  if (["day","曜日"].includes(t)) return "day";
  if (["kind","種別","カテゴリ","category"].includes(t)) return "kind";
  if (["slot","スロット","部位","タイム"].includes(t)) return "slot";
  if (["text","本文","内容","メニュー"].includes(t)) return "text";
  if (["calories","kcal","calories(kcal)","calories (kcal)","カロリー"].includes(t)) return "calories";
  if (["p","protein","タンパク質"].includes(t)) return "p";
  if (["f","fat","脂質"].includes(t)) return "f";
  if (["c","carb","carbs","炭水化物"].includes(t)) return "c";
  if (["tips","tip","note","notes","メモ","注意"].includes(t)) return "tips";
  return t;
}

function buildHeaderMap(tokensRaw){
  const map = new Map();
  tokensRaw.forEach((t,i)=>{ const k = normalizeHeaderToken(t); if(!map.has(k)) map.set(k,i); });
  const essential = ["week","day","kind","slot","text"];
  if(!essential.every(k=>map.has(k))) return null;
  return EXPECTED.map(k=>map.has(k)?map.get(k):-1);
}

function looksLikeHeaderRow(cols, mapper){
  if(!cols || cols.length<2) return false;
  const a = norm(cols[(mapper && mapper[0]!==undefined)?mapper[0]:0]);
  const b = norm(cols[(mapper && mapper[1]!==undefined)?mapper[1]:1]);
  return (a==="week" || a==="day") && (b==="day" || b==="kind");
}

/* ========== CSV/TSV/WS クリーナ（全文走査・フェールソフト） ========== */
function cleanseCsv(raw){
  const csv = raw.replace(/^```[a-z]*\n?/i,"").replace(/\n?```$/,"").trim();
  const all = csv.split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
  if(!all.length) return { rows:[], splitter:/,/, mapper: EXPECTED.map((_,i)=>i) };

  // 1) ヘッダー行を全文走査で探す（各行ごとに最適な区切りを再判定）
  let headerIdx = -1, mapper=null, splitter=/,/;
  for(let i=0;i<all.length;i++){
    const line = all[i];
    const cands = detectDelimiterCandidates(line);
    // 区切り候補＋「連続空白」も試す
    for(const cand of [...cands,{key:"WS",regex:/\s{2,}/,count:0}]){
      const tokens = line.split(cand.regex);
      const m = buildHeaderMap(tokens);
      if(m){ headerIdx=i; mapper=m; splitter=cand.regex; break; }
    }
    if(mapper) break;
  }

  if(headerIdx === -1){
    // どうしても見つからない → 先頭行を仮ヘッダーとして Week..Text を割当、残りは空
    console.warn("[cleanseCsv] header not found. fallback mapping.");
    const first = all[0];
    const cands = detectDelimiterCandidates(first);
    const chosen = (cands[0] && cands[0].count>0) ? cands[0].regex : /\s{2,}/;
    headerIdx = 0; splitter = chosen;
    const headerRaw = first.split(splitter);
    const fallback = headerRaw.slice(0,5).map((_,i)=>i);
    while(fallback.length<EXPECTED.length) fallback.push(-1);
    mapper = fallback;
  }

  // 2) 本文取り出し（途中の二重ヘッダー掃除）
  const body = all.slice(headerIdx+1).filter(line=>{
    const cols = line.split(splitter);
    return !looksLikeHeaderRow(cols, mapper);
  });

  if(body.length !== 35){
    console.warn(`[cleanseCsv] rows expected=35 actual=${body.length}`);
  }

  return { rows: body, splitter, mapper };
}

/* ========== 週次生成（Logs反映） ========== */
async function generateNextWeekWithGPT(getWeekAndDayJST){
  const { week } = getWeekAndDayJST(process.env.START_DATE);
  const nextWeek = week + 1;

  const { sheet, rows, idx } = await loadMealPlan();
  const exists = rows.some(r => String(r._rawData[idx.Week]).trim() === String(nextWeek));
  if(exists) return { created:0, skipped:true, week: nextWeek };

  // 今週要約
  const thisWeekRows = rows.filter(r => String(r._rawData[idx.Week]).trim() === String(week));
  const brief = thisWeekRows.slice(0,50).map(r=>[
    String(r._rawData[idx.Day]).trim(),
    String(r._rawData[idx.Kind]).trim(),
    String(r._rawData[idx.Slot]).trim(),
    String(r._rawData[idx.Text]).trim(),
    String(r._rawData[idx.Calories]).trim(),
    String(r._rawData[idx.P]).trim(),
    String(r._rawData[idx.F]).trim(),
    String(r._rawData[idx.C]).trim(),
  ].join("|")).join("\n");

  // 直近ログ（10日）
  const recentLogs = await getRecentLogs(10);
  const trainLogs = recentLogs.filter(x=>x.Kind==="Training");
  const mealLogs  = recentLogs.filter(x=>x.Kind==="Meal");
  const trainBrief = trainLogs.map(x=>`- ${x.Date} ${x.Slot}: ${x.Text}`).join("\n") || "- 直近トレ記録なし";
  const mealBrief  = mealLogs.slice(-7).map(x=>`- ${x.Date} ${x.Slot}: ${x.Text}`).join("\n");

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
- Text/Tipsは日本語（**カンマは禁止**。「・」等を使う）
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

  // ログに状況を出す（デバッグ容易化）
  console.log("[auto-gen] raw first 200:", raw.slice(0,200).replace(/\n/g,"⏎"));

  const { rows: filtered, splitter, mapper } = cleanseCsv(raw);

  const toInsert = [];
  for(const line of filtered){
    const src = line.split(splitter);
    const cols = EXPECTED.map((_,i)=>{
      const si = mapper[i];
      return si>=0 ? (src[si]??"").trim() : "";
    });

    if (looksLikeHeaderRow(cols, null)) continue; // 二重ヘッダー掃除
    if (cols.length < 10) continue;

    const row = {
      Week: cols[0], Day: cols[1], Kind: cols[2], Slot: cols[3],
      Text: cols[4], Calories: cols[5], P: cols[6], F: cols[7], C: cols[8], Tips: cols[9],
    };
    if(!row.Week || !row.Day || !row.Kind || !row.Slot || !row.Text) continue;
    toInsert.push(row);
  }

  let created = 0;
  if(toInsert.length){
    await chunkAddRows(sheet, toInsert);
    created = toInsert.length;
  }
  return { created, skipped:false, week: nextWeek };
}

module.exports = { generateNextWeekWithGPT };
