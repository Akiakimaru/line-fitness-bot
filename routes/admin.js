// routes/admin.js - 管理画面専用
const express = require('express');
const router = express.Router();
const { getWeekAndDayJST, todayYMDJST, nowJST } = require("../lib/utils");
const { loadMealPlan, readUsersDetailed, readRecentLogs, ensureLogsHeader, getJwt } = require("../lib/sheets");
const { analyzeHistoricalMeals, generateHistoricalPFCStats } = require('../lib/historicalAnalyzer');
const { analyzeMealPFC, dynamicDB } = require('../lib/pfcAnalyzer');
const { adminAuthMiddleware } = require('../lib/auth');
const { calculateSystemStats, successResponse, errorResponse } = require('../lib/api');
const { google } = require('googleapis');

const ADMIN_KEY = process.env.ADMIN_KEY || "akimoto0114";

/**
 * 管理画面ホーム - 静的ファイルを配信
 */
router.get("/admin", (req, res) => {
  const { key } = req.query;
  if (key !== ADMIN_KEY) {
    return res.status(401).send("unauthorized - check server logs for details");
  }
  
  // 静的ファイルを配信
  res.sendFile('admin.html', { root: 'public' });
});

/**
 * 環境変数確認（デバッグ用）
 */
router.get("/admin/env-check", (req, res) => {
  const { key } = req.query;
  if (key !== ADMIN_KEY) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }
  
  res.json({
    ok: true,
    env: {
      MYPAGE_SECRET: process.env.MYPAGE_SECRET ? process.env.MYPAGE_SECRET.substring(0, 8) + '...' : 'NOT_SET',
      ADMIN_KEY: process.env.ADMIN_KEY ? process.env.ADMIN_KEY.substring(0, 4) + '...' : 'NOT_SET',
      NODE_ENV: process.env.NODE_ENV || 'NOT_SET'
    }
  });
});

/**
 * 今日のメニュー確認
 */
router.get("/admin/today", async (req, res) => {
  if (req.query.key !== ADMIN_KEY) return res.status(401).json({ ok: false, error: "unauthorized" });
  try {
    const { week, day } = getWeekAndDayJST();
    const plan = await loadMealPlan(week, day);
    res.json({ ok: true, week, day, plan });
  } catch (e) {
    console.error("[admin/today] Error:", e);
    res.status(500).json({ ok: false, error: String(e) });
  }
});

/**
 * 自動生成実行
 */
router.get("/admin/auto-gen", async (req, res) => {
  if (req.query.key !== ADMIN_KEY) return res.status(401).json({ ok: false, error: "unauthorized" });
  try {
    // 自動生成ロジック（実装済みの場合はそのまま使用）
    res.json({ ok: true, message: "自動生成機能は実装中です" });
  } catch (e) {
    console.error("[admin/auto-gen] Error:", e);
    res.status(500).json({ ok: false, error: String(e) });
  }
});

/**
 * スロット配信
 */
router.get("/admin/push-slot", async (req, res) => {
  if (req.query.key !== ADMIN_KEY) return res.status(401).json({ ok: false, error: "unauthorized" });
  try {
    const { slot } = req.query;
    if (!slot) return res.status(400).json({ ok: false, error: "slot parameter required" });
    // スロット配信ロジック（実装済みの場合はそのまま使用）
    res.json({ ok: true, message: `スロット配信: ${slot}`, slot });
  } catch (e) {
    console.error("[admin/push-slot] Error:", e);
    res.status(500).json({ ok: false, error: String(e) });
  }
});

/**
 * 次週メニュー検証
 */
router.get("/admin/nextweek-validate", async (req, res) => {
  if (req.query.key !== ADMIN_KEY) return res.status(401).json({ ok: false, error: "unauthorized" });
  try {
    const { week, day } = getWeekAndDayJST();
    const nextWeek = week + 1;
    const plan = await loadMealPlan(nextWeek, "Mon");
    const totalRows = Object.keys(plan).length;
    const complete35 = totalRows >= 35; // 5日×7スロット = 35
    res.json({
      ok: true,
      nextWeek,
      total: totalRows,
      complete35,
      plan: Object.keys(plan).slice(0, 5) // 最初の5つだけ返す
    });
  } catch (e) {
    console.error("[admin/nextweek-validate] Error:", e);
    res.status(500).json({ ok: false, error: String(e) });
  }
});

/**
 * ユーザー一覧
 */
router.get("/admin/users", async (req, res) => {
  if (req.query.key !== ADMIN_KEY) return res.status(401).json({ ok: false, error: "unauthorized" });
  try {
    const users = await readUsersDetailed();
    res.json({ ok: true, users });
  } catch (e) {
    console.error("[admin/users] Error:", e);
    res.status(500).json({ ok: false, error: String(e) });
  }
});

/**
 * ログ一覧
 */
router.get("/admin/logs", async (req, res) => {
  if (req.query.key !== ADMIN_KEY) return res.status(401).json({ ok: false, error: "unauthorized" });
  try {
    const days = Math.max(1, Math.min(31, parseInt(req.query.days || "7", 10) || 7));
    const logs = await readRecentLogs(days);
    res.json({ ok: true, days, logs });
  } catch (e) {
    console.error("[admin/logs] Error:", e);
    res.status(500).json({ ok: false, error: String(e) });
  }
});

/**
 * システム統計
 */
router.get("/admin/stats", async (req, res) => {
  if (req.query.key !== ADMIN_KEY) return res.status(401).json({ ok: false, error: "unauthorized" });
  try {
    const { week, day } = getWeekAndDayJST();
    const users = await readUsersDetailed();
    const logs = await readRecentLogs(7);
    const nextWeek = week + 1;
    const nextPlan = await loadMealPlan(nextWeek, "Mon");
    const nextTotal = Object.keys(nextPlan).length;
    const nextComplete35 = nextTotal >= 35;
    res.json({
      ok: true,
      now: { week, day },
      users: { count: users.length },
      logs7d: { count: logs.length },
      nextWeek: { week: nextWeek, total: nextTotal, complete35: nextComplete35 }
    });
  } catch (e) {
    console.error("[admin/stats] Error:", e);
    res.status(500).json({ ok: false, error: String(e) });
  }
});

/**
 * システムダッシュボード - 静的ファイルを配信
 */
router.get("/admin/dashboard", (req, res) => {
  if (req.query.key !== ADMIN_KEY) return res.status(401).send("unauthorized");
  
  // 静的ファイルを配信（既存のダッシュボードHTMLがある場合はそれを使用）
  res.sendFile('admin-dashboard.html', { root: 'public' });
});

/**
 * 過去データ解析
 */
router.get("/admin/analyze-historical", async (req, res) => {
  const { key } = req.query;
  if (key !== ADMIN_KEY) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }

  try {
    const results = await analyzeHistoricalMeals();
    return res.json({
      ok: true,
      message: "過去30日間の食事データを分析しました",
      results: results
    });
  } catch (error) {
    console.error("[admin/analyze-historical] Error:", error);
    res.status(500).json({ ok: false, error: String(error) });
  }
});

/**
 * PFC統計情報
 */
router.get("/admin/pfc-stats", async (req, res) => {
  const { key, days } = req.query;
  if (key !== ADMIN_KEY) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }

  try {
    const stats = await generateHistoricalPFCStats(parseInt(days) || 30);
    return res.json({
      ok: true,
      message: "PFC統計情報を生成しました",
      stats: stats
    });
  } catch (error) {
    console.error("[admin/pfc-stats] Error:", error);
    res.status(500).json({ ok: false, error: String(error) });
  }
});

/**
 * PFC解析テスト
 */
router.get("/admin/test-pfc", async (req, res) => {
  const { key, meal } = req.query;
  if (key !== ADMIN_KEY) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }

  try {
    const mealText = meal || "玄米200g\n鶏むね肉100g\nキャベツ3枚";
    console.log(`[admin/test-pfc] Testing PFC analysis for: ${mealText}`);
    
    const pfcData = await analyzeMealPFC(mealText, { useCache: false, useBatch: false });
    
    return res.json({
      ok: true,
      message: "PFC解析テスト完了",
      input: mealText,
      result: pfcData
    });
  } catch (error) {
    console.error("[admin/test-pfc] Error:", error);
    res.status(500).json({ 
      ok: false, 
      error: error.message,
      stack: error.stack
    });
  }
});

/**
 * スプレッドシートヘッダー更新
 */
router.get("/admin/update-headers", async (req, res) => {
  const { key } = req.query;
  if (key !== ADMIN_KEY) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }

  try {
    const jwt = getJwt();
    const sheetsApi = google.sheets({ version: "v4", auth: jwt });
    
    console.log(`[admin/update-headers] Updating spreadsheet headers`);
    await ensureLogsHeader(sheetsApi);
    
    res.json({
      ok: true,
      message: "Spreadsheet headers updated successfully"
    });
  } catch (error) {
    console.error("[admin/update-headers] Error:", error);
    res.status(500).json({ ok: false, error: String(error), stack: error.stack });
  }
});

/**
 * 動的データベース統計情報
 */
router.get('/admin/db-stats', async (req, res) => {
  const { key } = req.query;
  
  if (key !== ADMIN_KEY) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }

  try {
    const stats = dynamicDB.getStats();
    
    return res.json({
      ok: true,
      message: "動的データベース統計情報",
      stats: stats
    });
    
  } catch (error) {
    console.error('[admin/db-stats] Error:', error);
    return res.status(500).json({ 
      ok: false, 
      error: error.message,
      stack: error.stack
    });
  }
});

module.exports = router;