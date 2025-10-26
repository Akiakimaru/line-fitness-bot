// lib/api.js - API共通機能
const { readRecentLogs, readUsersDetailed } = require('./sheets');
const { convertToGymDate } = require('./utils');

/**
 * 標準APIレスポンス形式
 */
function createResponse(ok, data = null, error = null, message = null) {
  const response = { ok };
  
  if (data !== null) response.data = data;
  if (error !== null) response.error = error;
  if (message !== null) response.message = message;
  
  return response;
}

/**
 * 成功レスポンス
 */
function successResponse(data, message = null) {
  return createResponse(true, data, null, message);
}

/**
 * エラーレスポンス
 */
function errorResponse(error, message = null) {
  return createResponse(false, null, error, message);
}

/**
 * ユーザーログ取得の共通処理
 */
async function getUserLogs(uid, days = 7) {
  try {
    const logs = await readRecentLogs(days);
    const userLogs = logs.filter(log => log.UserId === uid);
    
    return successResponse({
      uid,
      days,
      logs: userLogs,
      count: userLogs.length
    });
  } catch (error) {
    console.error('[getUserLogs] Error:', error);
    return errorResponse(String(error), 'ログの取得に失敗しました');
  }
}

/**
 * ユーザーサマリー計算の共通処理
 */
function calculateUserSummary(logs) {
  let weights = [];
  let gymSets = 0, gymMinutes = 0;
  let meals = 0;
  const gymDates = new Set(); // ジムに行った日付を記録（AM5時基準）
  
  for (const log of logs) {
    if (log.Kind === "Weight") {
      const weight = parseFloat(log.Text);
      if (!Number.isNaN(weight)) weights.push(weight);
    } else if (log.Kind === "Gym") {
      // ジムログの日付をAM5時基準で換算
      const gymDate = convertToGymDate(log.DateTime);
      gymDates.add(gymDate);
      
      const meta = log.Meta || {};
      if (Array.isArray(meta.parsed)) {
        for (const exercise of meta.parsed) {
          if (Array.isArray(exercise.sets)) gymSets += exercise.sets.length;
          if (exercise.minutes) gymMinutes += Number(exercise.minutes) || 0;
        }
      }
    } else if (log.Kind === "Meal") {
      meals += 1;
    }
  }
  
  return {
    meals,
    gymDays: gymDates.size,  // 記録回数ではなく、実施日数
    gymSets,
    gymMinutes,
    weights: weights.length > 0 ? {
      count: weights.length,
      latest: Math.max(...weights),
      average: weights.reduce((a, b) => a + b, 0) / weights.length
    } : null
  };
}

/**
 * システム統計計算の共通処理
 */
async function calculateSystemStats() {
  try {
    const { getWeekAndDayJST } = require('./utils');
    const { loadMealPlan } = require('./sheets');
    
    const { week, day } = getWeekAndDayJST();
    const users = await readUsersDetailed();
    const logs = await readRecentLogs(7);
    
    // 次週の統計
    const nextWeek = week + 1;
    const nextPlan = await loadMealPlan(nextWeek, "Mon");
    const nextTotal = Object.keys(nextPlan).length;
    const nextComplete35 = nextTotal >= 35;
    
    return successResponse({
      now: { week, day },
      users: { count: users.length },
      logs7d: { count: logs.length },
      nextWeek: { 
        week: nextWeek, 
        total: nextTotal, 
        complete35: nextComplete35 
      }
    });
  } catch (error) {
    console.error('[calculateSystemStats] Error:', error);
    return errorResponse(String(error), 'システム統計の計算に失敗しました');
  }
}

/**
 * ページネーション処理
 */
function paginateData(data, page = 1, limit = 20) {
  const offset = (page - 1) * limit;
  const paginatedData = data.slice(offset, offset + limit);
  
  return {
    data: paginatedData,
    pagination: {
      page: parseInt(page),
      limit: parseInt(limit),
      total: data.length,
      totalPages: Math.ceil(data.length / limit),
      hasNext: offset + limit < data.length,
      hasPrev: page > 1
    }
  };
}

/**
 * データ検証
 */
function validateRequest(req, requiredFields = []) {
  const errors = [];
  
  for (const field of requiredFields) {
    if (!req.query[field] && !req.body[field]) {
      errors.push(`${field} is required`);
    }
  }
  
  return {
    isValid: errors.length === 0,
    errors
  };
}

module.exports = {
  createResponse,
  successResponse,
  errorResponse,
  getUserLogs,
  calculateUserSummary,
  calculateSystemStats,
  paginateData,
  validateRequest
};
