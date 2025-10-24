const { generateText } = require('./llm');

/**
 * PFC解析システム（最適化版）
 * 食事内容をGPTで解析し、PFC値を計算する
 * - キャッシュ機能
 * - バッチ処理
 * - 非同期処理
 * - エラーハンドリング強化
 */

// キャッシュシステム
const PFC_CACHE = new Map();
const CACHE_EXPIRY = 24 * 60 * 60 * 1000; // 24時間

// バッチ処理キュー
const BATCH_QUEUE = [];
const BATCH_SIZE = 5;
const BATCH_INTERVAL = 2000; // 2秒間隔

// 処理中のリクエストを追跡
const PROCESSING_REQUESTS = new Set();

// 拡張食品データベース（実際の実装では外部APIを使用）
const FOOD_DATABASE = {
  // 主食
  "白米": { protein: 2.5, fat: 0.3, carbs: 36.8, calories: 168, unit: "100g" },
  "玄米": { protein: 2.8, fat: 0.7, carbs: 35.6, calories: 165, unit: "100g" },
  "パン": { protein: 8.0, fat: 3.0, carbs: 45.0, calories: 250, unit: "100g" },
  "うどん": { protein: 2.6, fat: 0.4, carbs: 21.6, calories: 105, unit: "100g" },
  "そば": { protein: 4.8, fat: 0.6, carbs: 26.0, calories: 132, unit: "100g" },
  "オートミール": { protein: 13.2, fat: 7.0, carbs: 66.2, calories: 389, unit: "100g" },
  
  // 肉類
  "鶏胸肉": { protein: 23.3, fat: 1.9, carbs: 0.0, calories: 108, unit: "100g" },
  "鶏むね肉": { protein: 23.3, fat: 1.9, carbs: 0.0, calories: 108, unit: "100g" },
  "鶏もも": { protein: 19.0, fat: 8.0, carbs: 0.0, calories: 155, unit: "100g" },
  "豚ロース": { protein: 19.3, fat: 19.2, carbs: 0.0, calories: 263, unit: "100g" },
  "牛肉": { protein: 20.0, fat: 15.0, carbs: 0.0, calories: 200, unit: "100g" },
  "卵": { protein: 12.3, fat: 10.3, carbs: 0.3, calories: 151, unit: "100g" },
  "半熟煮卵": { protein: 12.3, fat: 10.3, carbs: 0.3, calories: 151, unit: "100g" },
  
  // 魚類
  "鮭": { protein: 22.3, fat: 4.1, carbs: 0.0, calories: 133, unit: "100g" },
  "マグロ": { protein: 26.4, fat: 1.4, carbs: 0.0, calories: 125, unit: "100g" },
  "サバ": { protein: 20.7, fat: 12.1, carbs: 0.0, calories: 202, unit: "100g" },
  
  // 野菜
  "ブロッコリー": { protein: 4.3, fat: 0.2, carbs: 5.2, calories: 33, unit: "100g" },
  "キャベツ": { protein: 1.3, fat: 0.2, carbs: 5.2, calories: 23, unit: "100g" },
  "トマト": { protein: 0.7, fat: 0.1, carbs: 3.7, calories: 19, unit: "100g" },
  "玉ねぎ": { protein: 1.0, fat: 0.1, carbs: 8.8, calories: 37, unit: "100g" },
  "ほうれん草": { protein: 2.9, fat: 0.4, carbs: 3.6, calories: 23, unit: "100g" },
  "えのき": { protein: 2.7, fat: 0.2, carbs: 4.2, calories: 22, unit: "100g" },
  "もやし": { protein: 1.7, fat: 0.1, carbs: 2.9, calories: 14, unit: "100g" },
  
  // 豆類・納豆
  "納豆": { protein: 16.5, fat: 10.0, carbs: 12.1, calories: 200, unit: "100g" },
  "すごい納豆": { protein: 16.5, fat: 10.0, carbs: 12.1, calories: 200, unit: "100g" },
  
  // 乳製品
  "牛乳": { protein: 3.3, fat: 3.8, carbs: 4.8, calories: 67, unit: "100ml" },
  "ヨーグルト": { protein: 3.6, fat: 3.0, carbs: 4.9, calories: 62, unit: "100g" },
  "チーズ": { protein: 25.7, fat: 26.9, carbs: 1.3, calories: 356, unit: "100g" },
  
  // プロテイン・サプリメント
  "プロテイン": { protein: 80.0, fat: 1.0, carbs: 5.0, calories: 350, unit: "100g" },
  "ソイプロテイン": { protein: 80.0, fat: 1.0, carbs: 5.0, calories: 350, unit: "100g" },
  "EAA": { protein: 90.0, fat: 0.0, carbs: 0.0, calories: 360, unit: "100g" },
  "VALX EAA": { protein: 90.0, fat: 0.0, carbs: 0.0, calories: 360, unit: "100g" },
  "パルテノ": { protein: 25.0, fat: 1.0, carbs: 2.0, calories: 120, unit: "100g" },
  
  // ナッツ・種実類
  "ナッツ": { protein: 15.0, fat: 50.0, carbs: 20.0, calories: 600, unit: "100g" },
  "カリフォルニア堅果デイリーナッツ": { protein: 15.0, fat: 50.0, carbs: 20.0, calories: 600, unit: "100g" },
  
  // 調味料・その他
  "味噌": { protein: 12.1, fat: 6.0, carbs: 12.7, calories: 192, unit: "100g" },
  "味噌汁": { protein: 2.0, fat: 1.0, carbs: 3.0, calories: 30, unit: "100ml" },
  "醤油": { protein: 7.7, fat: 0.0, carbs: 4.9, calories: 71, unit: "100ml" },
  "油": { protein: 0.0, fat: 100.0, carbs: 0.0, calories: 921, unit: "100ml" },
  "MCTオイル": { protein: 0.0, fat: 100.0, carbs: 0.0, calories: 900, unit: "100ml" },
  "砂糖": { protein: 0.0, fat: 0.0, carbs: 100.0, calories: 384, unit: "100g" },
  "はちみつ": { protein: 0.3, fat: 0.0, carbs: 82.4, calories: 329, unit: "100g" },
  "明太子": { protein: 15.0, fat: 8.0, carbs: 2.0, calories: 130, unit: "100g" },
  
  // コンビニ食品
  "おにぎり": { protein: 3.0, fat: 1.0, carbs: 35.0, calories: 160, unit: "100g" },
  "セブンイレブンとり五目おにぎり": { protein: 3.0, fat: 1.0, carbs: 35.0, calories: 160, unit: "100g" },
  "セブンイレブン赤飯おこわむすび": { protein: 3.0, fat: 1.0, carbs: 35.0, calories: 160, unit: "100g" },
  "セブンイレブンねぎ盛り野菜と食べる砂肝ポン酢": { protein: 8.0, fat: 2.0, carbs: 5.0, calories: 80, unit: "100g" },
  
  // 麺類
  "炒め麺": { protein: 8.0, fat: 5.0, carbs: 45.0, calories: 250, unit: "100g" },
  "ブルダック炒め麺": { protein: 8.0, fat: 5.0, carbs: 45.0, calories: 250, unit: "100g" },
  
  // ドリンク
  "R1ドリンク": { protein: 0.0, fat: 0.0, carbs: 10.0, calories: 40, unit: "100ml" },
  "R1ドリンクタイプ": { protein: 0.0, fat: 0.0, carbs: 10.0, calories: 40, unit: "100ml" }
};

/**
 * キャッシュからPFCデータを取得
 */
function getCachedPFC(mealText) {
  const normalizedText = mealText.trim().toLowerCase();
  const cached = PFC_CACHE.get(normalizedText);
  
  if (cached && (Date.now() - cached.timestamp) < CACHE_EXPIRY) {
    console.log(`[getCachedPFC] Cache hit for: ${mealText.substring(0, 50)}...`);
    return cached.data;
  }
  
  return null;
}

/**
 * PFCデータをキャッシュに保存
 */
function setCachedPFC(mealText, pfcData) {
  const normalizedText = mealText.trim().toLowerCase();
  PFC_CACHE.set(normalizedText, {
    data: pfcData,
    timestamp: Date.now()
  });
  
  // キャッシュサイズ制限（最大1000件）
  if (PFC_CACHE.size > 1000) {
    const oldestKey = PFC_CACHE.keys().next().value;
    PFC_CACHE.delete(oldestKey);
  }
}

/**
 * バッチ処理システム
 */
class PFCBatchProcessor {
  constructor() {
    this.queue = [];
    this.processing = false;
    this.startBatchProcessor();
  }
  
  startBatchProcessor() {
    setInterval(() => {
      if (this.queue.length > 0 && !this.processing) {
        this.processBatch();
      }
    }, BATCH_INTERVAL);
  }
  
  async processBatch() {
    if (this.processing || this.queue.length === 0) return;
    
    this.processing = true;
    const batch = this.queue.splice(0, BATCH_SIZE);
    
    console.log(`[PFCBatchProcessor] Processing batch of ${batch.length} items`);
    
    try {
      // 並列処理でバッチを実行
      const promises = batch.map(item => this.processItem(item));
      await Promise.allSettled(promises);
    } catch (error) {
      console.error('[PFCBatchProcessor] Batch processing error:', error);
    } finally {
      this.processing = false;
    }
  }
  
  async processItem(item) {
    try {
      const { mealText, resolve, reject } = item;
      
      // キャッシュチェック
      const cached = getCachedPFC(mealText);
      if (cached) {
        resolve(cached);
        return;
      }
      
      // GPT解析実行
      const pfcData = await this.analyzeMealPFCInternal(mealText);
      
      // キャッシュに保存
      if (pfcData) {
        setCachedPFC(mealText, pfcData);
      }
      
      resolve(pfcData);
    } catch (error) {
      console.error('[PFCBatchProcessor] Item processing error:', error);
      item.reject(error);
    }
  }
  
  async analyzeMealPFCInternal(mealText) {
    try {
      console.log(`[analyzeMealPFCInternal] Starting analysis for: ${mealText.substring(0, 50)}...`);
      
      const parsedItems = await parseMealContent(mealText);
      console.log(`[analyzeMealPFCInternal] Parsed items:`, parsedItems);
      
      if (parsedItems.length === 0) {
        console.log(`[analyzeMealPFCInternal] No items parsed from: ${mealText}`);
        return null;
      }
      
      const pfcData = await calculatePFC(parsedItems);
      console.log(`[analyzeMealPFCInternal] PFC calculated:`, pfcData ? 'Success' : 'Failed');
      
      return pfcData;
    } catch (error) {
      console.error(`[analyzeMealPFCInternal] Error analyzing ${mealText}:`, error);
      return null;
    }
  }
  
  addToQueue(mealText) {
    return new Promise((resolve, reject) => {
      this.queue.push({ mealText, resolve, reject });
    });
  }
}

// グローバルバッチプロセッサー
const batchProcessor = new PFCBatchProcessor();

/**
 * 食事内容をGPTで解析し、食品リストを抽出
 */
async function parseMealContent(mealText) {
  try {
    const prompt = `
以下の食事内容を分析して、食品名と分量を抽出してください。

入力: "${mealText}"

以下のJSON形式で出力してください：
{
  "items": [
    {
      "name": "食品名",
      "amount": "分量",
      "unit": "単位",
      "quantity": 数値
    }
  ]
}

例：
{
  "items": [
    {
      "name": "白米",
      "amount": "150g",
      "unit": "g",
      "quantity": 150
    },
    {
      "name": "味噌汁",
      "amount": "1杯",
      "unit": "杯",
      "quantity": 1
    }
  ]
}

注意：
- 食品名は標準的な名前で統一してください
- 分量が不明な場合は適切に推定してください
- 調味料も含めてください
`;

    const response = await generateText(prompt);
    
    // JSONパース
    const parsed = JSON.parse(response);
    return parsed.items || [];
    
  } catch (error) {
    console.error('[parseMealContent] Error:', error);
    return [];
  }
}

/**
 * GPTを使用して未知の食品のPFC情報を取得
 */
async function getPFCFromGPT(foodName, amount, unit) {
  try {
    console.log(`[getPFCFromGPT] Searching PFC for: ${foodName} ${amount}${unit}`);
    
    const prompt = `
以下の食品の栄養成分（PFC）とカロリーを調べて、正確な情報を提供してください。

食品名: "${foodName}"
分量: ${amount}${unit}

以下のJSON形式で出力してください：
{
  "protein": タンパク質(g),
  "fat": 脂質(g),
  "carbs": 炭水化物(g),
  "calories": カロリー(kcal),
  "confidence": 信頼度(0.0-1.0),
  "source": "情報源の説明"
}

注意事項：
- 分量は${amount}${unit}基準で計算してください
- 100gあたりの値ではなく、指定分量での値を提供してください
- 信頼度は情報の確実性を示してください（1.0が最も確実）
- 情報源を簡潔に説明してください（例：「文部科学省食品成分表」「一般的な栄養情報」等）
- 不明な場合は推測値でも構いませんが、信頼度を低く設定してください

例：
{
  "protein": 25.5,
  "fat": 8.2,
  "carbs": 45.3,
  "calories": 350.2,
  "confidence": 0.9,
  "source": "文部科学省食品成分表2020年版"
}
`;

    const response = await generateText(prompt);
    
    // JSONパース
    const pfcData = JSON.parse(response);
    
    // バリデーション
    if (typeof pfcData.protein !== 'number' || 
        typeof pfcData.fat !== 'number' || 
        typeof pfcData.carbs !== 'number' || 
        typeof pfcData.calories !== 'number') {
      throw new Error('Invalid PFC data format from GPT');
    }
    
    console.log(`[getPFCFromGPT] Success: ${foodName} - P${pfcData.protein}g F${pfcData.fat}g C${pfcData.carbs}g (${pfcData.calories}kcal)`);
    
    return pfcData;
    
  } catch (error) {
    console.error(`[getPFCFromGPT] Error for ${foodName}:`, error);
    return null;
  }
}

/**
 * 食品名を標準化（データベースのキーにマッチ）
 */
function standardizeFoodName(foodName) {
  // 拡張された標準化ロジック
  const nameMap = {
    // 主食
    "ご飯": "白米",
    "お米": "白米",
    "ライス": "白米",
    "食パン": "パン",
    
    // 卵類
    "卵焼き": "卵",
    "目玉焼き": "卵",
    "ゆで卵": "卵",
    "半熟卵": "半熟煮卵",
    
    // 肉類
    "鶏肉": "鶏胸肉",
    "鶏胸": "鶏胸肉",
    "豚肉": "豚ロース",
    "魚": "鮭",
    
    // プロテイン・サプリメント
    "プロテイン": "ソイプロテイン",
    "EAA": "VALX EAA",
    
    // コンビニ食品
    "おにぎり": "セブンイレブンとり五目おにぎり",
    "赤飯おにぎり": "セブンイレブン赤飯おこわむすび",
    
    // 麺類
    "麺": "炒め麺",
    "炒麺": "ブルダック炒め麺",
    
    // ドリンク
    "R1": "R1ドリンクタイプ"
  };
  
  // 部分マッチングも試行
  for (const [key, value] of Object.entries(nameMap)) {
    if (foodName.includes(key)) {
      return value;
    }
  }
  
  // 直接マッチング
  return nameMap[foodName] || foodName;
}

/**
 * 分量を正規化（100g基準に変換）
 */
function normalizeAmount(amount, unit, foodName) {
  const foodData = FOOD_DATABASE[foodName];
  if (!foodData) return 100; // デフォルト100g
  
  // 単位変換
  switch (unit) {
    case 'g':
      return amount;
    case 'kg':
      return amount * 1000;
    case 'ml':
      return amount; // 液体はml = gと仮定
    case 'l':
      return amount * 1000;
    case '個':
      // 食品ごとの1個あたりの重量を推定
      const pieceWeights = {
        "卵": 50,
        "半熟煮卵": 50,
        "パン": 30,
        "トマト": 150,
        "玉ねぎ": 200,
        "納豆": 50,
        "すごい納豆": 50,
        "おにぎり": 100,
        "セブンイレブンとり五目おにぎり": 100,
        "セブンイレブン赤飯おこわむすび": 100
      };
      return amount * (pieceWeights[foodName] || 100);
    case '杯':
      // 1杯あたりの重量を推定
      const cupWeights = {
        "味噌汁": 150,
        "牛乳": 200,
        "白米": 150,
        "玄米": 150
      };
      return amount * (cupWeights[foodName] || 150);
    case '袋':
      // 1袋あたりの重量を推定
      const bagWeights = {
        "カリフォルニア堅果デイリーナッツ": 30,
        "ナッツ": 30,
        "ブルダック炒め麺": 100
      };
      return amount * (bagWeights[foodName] || 50);
    case 'パック':
      // 1パックあたりの重量を推定
      const packWeights = {
        "納豆": 50,
        "すごい納豆": 50
      };
      return amount * (packWeights[foodName] || 50);
    case '株':
      // 1株あたりの重量を推定
      const bunchWeights = {
        "えのき": 100,
        "ほうれん草": 200
      };
      return amount * (bunchWeights[foodName] || 100);
    case '枚':
      // 1枚あたりの重量を推定
      const sheetWeights = {
        "キャベツ": 20,
        "パン": 30
      };
      return amount * (sheetWeights[foodName] || 20);
    default:
      return amount;
  }
}

/**
 * PFC値を計算（GPTフォールバック付き）
 */
async function calculatePFC(parsedItems) {
  try {
    let totalProtein = 0;
    let totalFat = 0;
    let totalCarbs = 0;
    let totalCalories = 0;
    
    const itemDetails = [];
    let processedItems = 0;
    let unknownItems = 0;
    let gptItems = 0;
    
    console.log(`[calculatePFC] Processing ${parsedItems.length} items`);
    
    for (const item of parsedItems) {
      const foodName = standardizeFoodName(item.name);
      const foodData = FOOD_DATABASE[foodName];
      
      let protein, fat, carbs, calories, confidence, source;
      
      if (foodData) {
        // データベースから取得
        const normalizedAmount = normalizeAmount(item.quantity, item.unit, foodName);
        const multiplier = normalizedAmount / 100; // 100g基準
        
        protein = foodData.protein * multiplier;
        fat = foodData.fat * multiplier;
        carbs = foodData.carbs * multiplier;
        calories = foodData.calories * multiplier;
        confidence = 0.9; // データベースの信頼度
        source = "local_database";
        
        console.log(`[calculatePFC] Using database for: ${foodName}`);
      } else {
        // GPTで検索
        console.log(`[calculatePFC] Unknown food, using GPT for: ${foodName}`);
        const gptData = await getPFCFromGPT(foodName, item.quantity, item.unit);
        
        if (gptData) {
          protein = gptData.protein;
          fat = gptData.fat;
          carbs = gptData.carbs;
          calories = gptData.calories;
          confidence = gptData.confidence || 0.7;
          source = gptData.source || "gpt_search";
          gptItems++;
        } else {
          console.warn(`[calculatePFC] GPT failed for: ${foodName} (original: ${item.name})`);
          unknownItems++;
          continue;
        }
      }
      
      totalProtein += protein;
      totalFat += fat;
      totalCarbs += carbs;
      totalCalories += calories;
      
      itemDetails.push({
        name: foodName,
        amount: `${item.quantity}${item.unit}`,
        protein: Math.round(protein * 10) / 10,
        fat: Math.round(fat * 10) / 10,
        carbs: Math.round(carbs * 10) / 10,
        calories: Math.round(calories * 10) / 10,
        confidence: confidence,
        source: source
      });
      
      processedItems++;
    }
    
    console.log(`[calculatePFC] Processed: ${processedItems}, GPT: ${gptItems}, Unknown: ${unknownItems}`);
    
    if (processedItems === 0) {
      console.log(`[calculatePFC] No items could be processed`);
      return null;
    }
    
    // カロリー計算の検証
    const calculatedCalories = (totalProtein * 4) + (totalFat * 9) + (totalCarbs * 4);
    const calorieDifference = Math.abs(totalCalories - calculatedCalories);
    const calorieAccuracy = calorieDifference < 50 ? "high" : calorieDifference < 100 ? "medium" : "low";
    
    const result = {
      total: {
        protein: Math.round(totalProtein * 10) / 10,
        fat: Math.round(totalFat * 10) / 10,
        carbs: Math.round(totalCarbs * 10) / 10,
        calories: Math.round(totalCalories * 10) / 10
      },
      items: itemDetails,
      parsed_at: new Date().toISOString(),
      method: gptItems > 0 ? "gpt+local_db+web" : "gpt+local_db",
      stats: {
        processed: processedItems,
        gpt_searched: gptItems,
        unknown: unknownItems,
        total: parsedItems.length,
        calorie_accuracy: calorieAccuracy,
        calorie_difference: Math.round(calorieDifference * 10) / 10
      }
    };
    
    console.log(`[calculatePFC] Result: P${result.total.protein}g F${result.total.fat}g C${result.total.carbs}g (${result.total.calories}kcal)`);
    console.log(`[calculatePFC] Calorie accuracy: ${calorieAccuracy} (diff: ${calorieDifference}kcal)`);
    return result;
    
  } catch (error) {
    console.error('[calculatePFC] Error:', error);
    return null;
  }
}

/**
 * メイン関数：食事内容からPFC値を算出（最適化版）
 */
async function analyzeMealPFC(mealText, options = {}) {
  const { useCache = true, useBatch = false, timeout = 10000 } = options;
  
  try {
    console.log(`[analyzeMealPFC] Analyzing: ${mealText.substring(0, 50)}...`);
    
    // 1. キャッシュチェック
    if (useCache) {
      const cached = getCachedPFC(mealText);
      if (cached) {
        console.log(`[analyzeMealPFC] Cache hit, returning cached data`);
        return cached;
      }
    }
    
    // 2. バッチ処理または即座処理
    let pfcData;
    if (useBatch) {
      console.log(`[analyzeMealPFC] Adding to batch queue`);
      pfcData = await Promise.race([
        batchProcessor.addToQueue(mealText),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Batch processing timeout')), timeout)
        )
      ]);
    } else {
      // 即座処理
      const parsedItems = await parseMealContent(mealText);
      if (parsedItems.length === 0) {
        return null;
      }
      pfcData = calculatePFC(parsedItems);
      
      // キャッシュに保存
      if (useCache && pfcData) {
        setCachedPFC(mealText, pfcData);
      }
    }
    
    console.log(`[analyzeMealPFC] PFC calculated:`, pfcData ? 'Success' : 'Failed');
    return pfcData;
    
  } catch (error) {
    console.error('[analyzeMealPFC] Error:', error);
    return null;
  }
}

/**
 * 非同期PFC解析（レスポンス時間改善）
 */
async function analyzeMealPFCAsync(mealText, callback) {
  try {
    // バッチ処理で非同期実行
    const pfcData = await batchProcessor.addToQueue(mealText);
    if (callback) {
      callback(null, pfcData);
    }
    return pfcData;
  } catch (error) {
    console.error('[analyzeMealPFCAsync] Error:', error);
    if (callback) {
      callback(error, null);
    }
    return null;
  }
}

/**
 * 複数の食事を一括解析
 */
async function analyzeMultipleMeals(mealTexts) {
  try {
    console.log(`[analyzeMultipleMeals] Analyzing ${mealTexts.length} meals`);
    
    const results = await Promise.allSettled(
      mealTexts.map(mealText => analyzeMealPFC(mealText, { useCache: true, useBatch: false }))
    );
    
    const successful = results.filter(r => r.status === 'fulfilled' && r.value).length;
    const gptSearched = results.filter(r => 
      r.status === 'fulfilled' && 
      r.value && 
      r.value.stats?.gpt_searched > 0
    ).length;
    
    console.log(`[analyzeMultipleMeals] Completed: ${successful}/${mealTexts.length} successful (${gptSearched} used GPT)`);
    
    return results.map((result, index) => ({
      mealText: mealTexts[index],
      pfcData: result.status === 'fulfilled' ? result.value : null,
      error: result.status === 'rejected' ? result.reason : null
    }));
    
  } catch (error) {
    console.error('[analyzeMultipleMeals] Error:', error);
    throw error;
  }
}

module.exports = {
  analyzeMealPFC,
  analyzeMealPFCAsync,
  analyzeMultipleMeals,
  parseMealContent,
  calculatePFC,
  getPFCFromGPT,
  getCachedPFC,
  setCachedPFC,
  FOOD_DATABASE,
  batchProcessor
};
