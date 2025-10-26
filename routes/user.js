// routes/user.js - ユーザー向けページ
const express = require('express');
const router = express.Router();
const { readRecentLogs } = require('../lib/sheets');
const { userAuthMiddleware, verifyUserLink } = require('../lib/auth');
const { getUserLogs, calculateUserSummary, successResponse, errorResponse } = require('../lib/api');
const { dynamicDB } = require('../lib/pfcAnalyzer');
const { getActiveShoppingPlan } = require('../lib/sheets');

/**
 * マイページ - 静的ファイルを配信
 */
router.get("/mypage", (req, res) => {
  const { uid, exp, sig } = req.query;
  console.log("[mypage] params:", { uid, exp, sig });
  const isValid = verifyUserLink(String(uid || ""), Number(exp), String(sig || ""));
  console.log("[mypage] verify result:", isValid);
  if (!isValid) {
    return res.status(401).send("unauthorized - check server logs for details");
  }
  
  // 静的ファイルを配信
  res.sendFile('mypage.html', { root: 'public' });
});

/**
 * ジムメニュー - 静的ファイルを配信
 */
router.get("/gym-menu", (req, res) => {
  const { uid, exp, sig } = req.query;
  console.log("[gym-menu] params:", { uid, exp, sig });
  const isValid = verifyUserLink(String(uid || ""), Number(exp), String(sig || ""));
  console.log("[gym-menu] verify result:", isValid);
  if (!isValid) {
    return res.status(401).send("unauthorized - check server logs for details");
  }
  
  // 静的ファイルを配信
  res.sendFile('gym-menu.html', { root: 'public' });
});

/**
 * 食品データベースページ - 静的ファイルを配信
 */
router.get("/food-db", (req, res) => {
  const { uid, exp, sig } = req.query;
  console.log("[food-db] params:", { uid, exp, sig });
  const isValid = verifyUserLink(String(uid || ""), Number(exp), String(sig || ""));
  console.log("[food-db] verify result:", isValid);
  if (!isValid) {
    return res.status(401).send("unauthorized - check server logs for details");
  }
  
  // 静的ファイルを配信
  res.sendFile('food-db.html', { root: 'public' });
});

/**
 * 買い出し計画表示ページ - 静的ファイルを配信
 */
router.get("/shopping-plan-view", (req, res) => {
  const { uid, exp, sig } = req.query;
  console.log("[shopping-plan-view] params:", { uid, exp, sig });
  const isValid = verifyUserLink(String(uid || ""), Number(exp), String(sig || ""));
  console.log("[shopping-plan-view] verify result:", isValid);
  if (!isValid) {
    return res.status(401).send("unauthorized - check server logs for details");
  }
  
  // 静的ファイルを配信
  res.sendFile('shopping-plan-view.html', { root: 'public' });
});

/**
 * 使い方ガイドページ - 静的ファイルを配信
 */
router.get("/guide", (req, res) => {
  const { uid, exp, sig } = req.query;
  console.log("[guide] params:", { uid, exp, sig });
  const isValid = verifyUserLink(String(uid || ""), Number(exp), String(sig || ""));
  console.log("[guide] verify result:", isValid);
  if (!isValid) {
    return res.status(401).send("unauthorized - check server logs for details");
  }
  
  // 静的ファイルを配信
  res.sendFile('guide.html', { root: 'public' });
});

/**
 * ユーザーログAPI
 */
router.get("/user/logs", userAuthMiddleware, async (req, res) => {
  try {
    const { uid } = req.query;
    const days = Math.max(1, Math.min(31, parseInt(req.query.days || "7", 10) || 7));
    const result = await getUserLogs(uid, days);
    console.log(`[user/logs] Response for uid=${uid}, days=${days}:`, JSON.stringify(result, null, 2));
    res.json(result);
  } catch (e) {
    console.error("[user/logs] Error:", e);
    res.status(500).json(errorResponse(String(e), 'ログの取得に失敗しました'));
  }
});

/**
 * ユーザーサマリーAPI
 */
router.get("/user/summary", userAuthMiddleware, async (req, res) => {
  try {
    const { uid } = req.query;
    const days = Math.max(1, Math.min(31, parseInt(req.query.days || "7", 10) || 7));
    const logs = (await readRecentLogs(days)).filter(r => r.UserId === uid);
    const summary = calculateUserSummary(logs);
    
    const result = successResponse({
      uid,
      days,
      ...summary
    });
    console.log(`[user/summary] Response for uid=${uid}, days=${days}:`, JSON.stringify(result, null, 2));
    res.json(result);
  } catch (e) {
    console.error("[user/summary] Error:", e);
    res.status(500).json(errorResponse(String(e), 'サマリーの計算に失敗しました'));
  }
});

/**
 * 買い出し計画取得API
 */
router.get("/user/shopping-plan", userAuthMiddleware, async (req, res) => {
  try {
    const { uid } = req.query;
    
    // 最新の有効な買い出し計画を取得
    const plan = await getActiveShoppingPlan(uid);
    
    if (!plan) {
      return res.json(successResponse({ plan: null }, '買い出し計画が見つかりません'));
    }
    
    res.json(successResponse({ plan }, '買い出し計画を取得しました'));
    
  } catch (error) {
    console.error('[user/shopping-plan] Error:', error);
    res.status(500).json(errorResponse(String(error), '買い出し計画の取得に失敗しました'));
  }
});

/**
 * 動的食品データベース参照API
 */
router.get("/user/food-db", userAuthMiddleware, async (req, res) => {
  try {
    const { search } = req.query;
    const stats = dynamicDB.getStats();
    
    let foodData = {};
    
    if (search) {
      // 検索機能
      const searchTerm = search.toLowerCase();
      const allFoods = dynamicDB.getAllFoods();
      
      for (const [foodName, data] of Object.entries(allFoods)) {
        if (foodName.toLowerCase().includes(searchTerm)) {
          foodData[foodName] = data;
        }
      }
    } else {
      // 全データ取得（制限付き）
      const allFoods = dynamicDB.getAllFoods();
      const entries = Object.entries(allFoods);
      
      // 最新の50件のみ表示
      const recentEntries = entries.slice(-50);
      foodData = Object.fromEntries(recentEntries);
    }
    
    res.json(successResponse({
      stats,
      foodData,
      search: search || null,
      totalFound: Object.keys(foodData).length
    }));
  } catch (e) {
    console.error("[user/food-db] Error:", e);
    res.status(500).json(errorResponse(String(e), '食品データベースの取得に失敗しました'));
  }
});

module.exports = router;
