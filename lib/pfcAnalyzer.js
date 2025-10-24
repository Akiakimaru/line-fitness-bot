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

// 簡易食品データベース（実際の実装では外部APIを使用）
const FOOD_DATABASE = {
  // 主食
  "白米": { protein: 2.5, fat: 0.3, carbs: 36.8, calories: 168, unit: "100g" },
  "玄米": { protein: 2.8, fat: 0.7, carbs: 35.6, calories: 165, unit: "100g" },
  "パン": { protein: 8.0, fat: 3.0, carbs: 45.0, calories: 250, unit: "100g" },
  "うどん": { protein: 2.6, fat: 0.4, carbs: 21.6, calories: 105, unit: "100g" },
  "そば": { protein: 4.8, fat: 0.6, carbs: 26.0, calories: 132, unit: "100g" },
  
  // 肉類
  "鶏胸肉": { protein: 23.3, fat: 1.9, carbs: 0.0, calories: 108, unit: "100g" },
  "豚ロース": { protein: 19.3, fat: 19.2, carbs: 0.0, calories: 263, unit: "100g" },
  "牛肉": { protein: 20.0, fat: 15.0, carbs: 0.0, calories: 200, unit: "100g" },
  "卵": { protein: 12.3, fat: 10.3, carbs: 0.3, calories: 151, unit: "100g" },
  
  // 魚類
  "鮭": { protein: 22.3, fat: 4.1, carbs: 0.0, calories: 133, unit: "100g" },
  "マグロ": { protein: 26.4, fat: 1.4, carbs: 0.0, calories: 125, unit: "100g" },
  "サバ": { protein: 20.7, fat: 12.1, carbs: 0.0, calories: 202, unit: "100g" },
  
  // 野菜
  "ブロッコリー": { protein: 4.3, fat: 0.2, carbs: 5.2, calories: 33, unit: "100g" },
  "キャベツ": { protein: 1.3, fat: 0.2, carbs: 5.2, calories: 23, unit: "100g" },
  "トマト": { protein: 0.7, fat: 0.1, carbs: 3.7, calories: 19, unit: "100g" },
  "玉ねぎ": { protein: 1.0, fat: 0.1, carbs: 8.8, calories: 37, unit: "100g" },
  
  // 乳製品
  "牛乳": { protein: 3.3, fat: 3.8, carbs: 4.8, calories: 67, unit: "100ml" },
  "ヨーグルト": { protein: 3.6, fat: 3.0, carbs: 4.9, calories: 62, unit: "100g" },
  "チーズ": { protein: 25.7, fat: 26.9, carbs: 1.3, calories: 356, unit: "100g" },
  
  // 調味料・その他
  "味噌": { protein: 12.1, fat: 6.0, carbs: 12.7, calories: 192, unit: "100g" },
  "醤油": { protein: 7.7, fat: 0.0, carbs: 4.9, calories: 71, unit: "100ml" },
  "油": { protein: 0.0, fat: 100.0, carbs: 0.0, calories: 921, unit: "100ml" },
  "砂糖": { protein: 0.0, fat: 0.0, carbs: 100.0, calories: 384, unit: "100g" }
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
    const parsedItems = await parseMealContent(mealText);
    if (parsedItems.length === 0) return null;
    return calculatePFC(parsedItems);
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
 * 食品名を標準化（データベースのキーにマッチ）
 */
function standardizeFoodName(foodName) {
  // 簡易的な標準化ロジック
  const nameMap = {
    "ご飯": "白米",
    "お米": "白米",
    "ライス": "白米",
    "食パン": "パン",
    "卵焼き": "卵",
    "目玉焼き": "卵",
    "ゆで卵": "卵",
    "鶏肉": "鶏胸肉",
    "豚肉": "豚ロース",
    "魚": "鮭"
  };
  
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
        "パン": 30,
        "トマト": 150,
        "玉ねぎ": 200
      };
      return amount * (pieceWeights[foodName] || 100);
    case '杯':
      // 1杯あたりの重量を推定
      const cupWeights = {
        "味噌汁": 150,
        "牛乳": 200,
        "白米": 150
      };
      return amount * (cupWeights[foodName] || 150);
    default:
      return amount;
  }
}

/**
 * PFC値を計算
 */
function calculatePFC(parsedItems) {
  let totalProtein = 0;
  let totalFat = 0;
  let totalCarbs = 0;
  let totalCalories = 0;
  
  const itemDetails = [];
  
  for (const item of parsedItems) {
    const foodName = standardizeFoodName(item.name);
    const foodData = FOOD_DATABASE[foodName];
    
    if (!foodData) {
      console.warn(`[calculatePFC] Unknown food: ${foodName}`);
      continue;
    }
    
    const normalizedAmount = normalizeAmount(item.quantity, item.unit, foodName);
    const multiplier = normalizedAmount / 100; // 100g基準
    
    const protein = foodData.protein * multiplier;
    const fat = foodData.fat * multiplier;
    const carbs = foodData.carbs * multiplier;
    const calories = foodData.calories * multiplier;
    
    totalProtein += protein;
    totalFat += fat;
    totalCarbs += carbs;
    totalCalories += calories;
    
    itemDetails.push({
      name: foodName,
      amount: `${normalizedAmount.toFixed(0)}g`,
      protein: protein,
      fat: fat,
      carbs: carbs,
      calories: calories,
      confidence: 0.8 // 簡易的な信頼度
    });
  }
  
  return {
    total: {
      protein: Math.round(totalProtein * 10) / 10,
      fat: Math.round(totalFat * 10) / 10,
      carbs: Math.round(totalCarbs * 10) / 10,
      calories: Math.round(totalCalories * 10) / 10
    },
    items: itemDetails,
    parsed_at: new Date().toISOString(),
    method: "gpt+local_db"
  };
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
    console.log(`[analyzeMultipleMeals] Completed: ${successful}/${mealTexts.length} successful`);
    
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
  getCachedPFC,
  setCachedPFC,
  FOOD_DATABASE,
  batchProcessor
};
