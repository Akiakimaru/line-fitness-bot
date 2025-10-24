const { readRecentLogs } = require('./sheets');
const { analyzeMealPFC, analyzeMultipleMeals } = require('./pfcAnalyzer');

/**
 * 過去データのPFC分析機能
 */

/**
 * 指定期間の食事ログを取得してPFC分析を実行
 */
async function analyzeHistoricalMeals(days = 30) {
  try {
    console.log(`[analyzeHistoricalMeals] Analyzing ${days} days of historical data`);
    
    // 過去の食事ログを取得
    const logs = await readRecentLogs(days);
    const mealLogs = logs.filter(log => log.Kind === 'Meal');
    
    console.log(`[analyzeHistoricalMeals] Found ${mealLogs.length} meal logs`);
    
    // 既にPFCデータがあるログを除外
    const logsToProcess = mealLogs.filter(log => !log.PFC || Object.keys(log.PFC).length === 0);
    const skippedCount = mealLogs.length - logsToProcess.length;
    
    console.log(`[analyzeHistoricalMeals] Processing ${logsToProcess.length} logs (${skippedCount} already have PFC data)`);
    
    // バッチ処理で効率的に解析
    const mealTexts = logsToProcess.map(log => log.Text);
    const batchResults = await analyzeMultipleMeals(mealTexts);
    
    console.log(`[analyzeHistoricalMeals] Batch results:`, batchResults.length);
    
    const results = batchResults.map((result, index) => {
      const log = logsToProcess[index];
      const pfcData = result.pfcData;
      const error = result.error;
      
      console.log(`[analyzeHistoricalMeals] Processing log ${index}: ${log.Text.substring(0, 30)}...`);
      console.log(`[analyzeHistoricalMeals] PFC result:`, pfcData ? 'Success' : 'Failed', error ? `Error: ${error}` : '');
      
      return {
        logId: `${log.DateTime}_${log.UserId}`,
        originalLog: log,
        pfcData: pfcData,
        confidenceScore: pfcData ? (pfcData.stats?.processed > 0 ? 0.8 : 0.5) : null,
        error: error ? error.message || String(error) : null
      };
    });
    
    const processedCount = results.filter(r => r.pfcData).length;
    
    console.log(`[analyzeHistoricalMeals] Completed: ${processedCount} processed, ${skippedCount} skipped`);
    
    return {
      totalLogs: mealLogs.length,
      processed: processedCount,
      skipped: skippedCount,
      results: results
    };
    
  } catch (error) {
    console.error('[analyzeHistoricalMeals] Error:', error);
    throw error;
  }
}

/**
 * 過去データのPFC統計を生成
 */
async function generateHistoricalPFCStats(days = 30) {
  try {
    const logs = await readRecentLogs(days);
    const mealLogs = logs.filter(log => log.Kind === 'Meal' && log.PFC && log.PFC.total);
    
    if (mealLogs.length === 0) {
      return {
        message: 'PFCデータが見つかりません。過去データの分析を実行してください。',
        stats: null
      };
    }
    
    // ユーザー別統計
    const userStats = {};
    const dailyStats = {};
    
    mealLogs.forEach(log => {
      const userId = log.UserId;
      const date = new Date(log.DateTime).toDateString();
      const pfc = log.PFC.total;
      
      // ユーザー別統計
      if (!userStats[userId]) {
        userStats[userId] = {
          totalMeals: 0,
          totalProtein: 0,
          totalFat: 0,
          totalCarbs: 0,
          totalCalories: 0
        };
      }
      
      userStats[userId].totalMeals++;
      userStats[userId].totalProtein += pfc.protein || 0;
      userStats[userId].totalFat += pfc.fat || 0;
      userStats[userId].totalCarbs += pfc.carbs || 0;
      userStats[userId].totalCalories += pfc.calories || 0;
      
      // 日別統計
      if (!dailyStats[date]) {
        dailyStats[date] = {
          totalMeals: 0,
          totalProtein: 0,
          totalFat: 0,
          totalCarbs: 0,
          totalCalories: 0
        };
      }
      
      dailyStats[date].totalMeals++;
      dailyStats[date].totalProtein += pfc.protein || 0;
      dailyStats[date].totalFat += pfc.fat || 0;
      dailyStats[date].totalCarbs += pfc.carbs || 0;
      dailyStats[date].totalCalories += pfc.calories || 0;
    });
    
    // 平均値計算
    const totalDays = Object.keys(dailyStats).length;
    const totalMeals = mealLogs.length;
    
    const overallStats = {
      period: `${days}日間`,
      totalMeals: totalMeals,
      totalDays: totalDays,
      averageMealsPerDay: (totalMeals / totalDays).toFixed(1),
      averageProteinPerDay: Object.values(dailyStats).reduce((sum, day) => sum + day.totalProtein, 0) / totalDays,
      averageFatPerDay: Object.values(dailyStats).reduce((sum, day) => sum + day.totalFat, 0) / totalDays,
      averageCarbsPerDay: Object.values(dailyStats).reduce((sum, day) => sum + day.totalCarbs, 0) / totalDays,
      averageCaloriesPerDay: Object.values(dailyStats).reduce((sum, day) => sum + day.totalCalories, 0) / totalDays
    };
    
    return {
      message: '過去データのPFC統計を生成しました。',
      overallStats: overallStats,
      userStats: userStats,
      dailyStats: dailyStats
    };
    
  } catch (error) {
    console.error('[generateHistoricalPFCStats] Error:', error);
    throw error;
  }
}

/**
 * 過去データのPFC分析結果をスプレッドシートに保存
 */
async function saveHistoricalPFCResults(results) {
  // この機能は後で実装
  // 現在は結果を返すのみ
  console.log(`[saveHistoricalPFCResults] Would save ${results.length} PFC analysis results`);
  return results;
}

module.exports = {
  analyzeHistoricalMeals,
  generateHistoricalPFCStats,
  saveHistoricalPFCResults
};
