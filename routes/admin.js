// routes/admin.js
const express = require("express");
const router = express.Router();

const ADMIN_KEY = process.env.ADMIN_KEY || "";

const { getWeekAndDayJST } = require("../lib/utils");
const { loadMealPlan } = require("../lib/sheets");
const { generateNextWeekWithGPT } = require("../lib/llm");
const { pushSlot } = require("../services/scheduler"); // ← Usersシートから全員にPUSH
const { getTodayMenuText } = require("../services/lineHandlers"); // 表示用

/** ヘルスチェック */
router.get("/", (_req, res) => res.send("LINE Fitness Bot OK"));

/** 現在の週・曜日 */
router.get("/debug-week", (_req, res) => {
  try {
    const { week, day, jstISO } = getWeekAndDayJST(process.env.START_DATE);
    res.json({ START_DATE: process.env.START_DATE, week, day, jstISO });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

/** 今日のメニュー全文（従来どおり） */
router.get("/admin/today", async (req, res) => {
  if (req.query.key !== ADMIN_KEY) return res.status(401).send("unauthorized");
  try {
    const text = await getTodayMenuText();
    res.json({ ok: true, text });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

/** 次週のGPT自動生成（手動トリガ） */
router.get("/admin/auto-gen", async (req, res) => {
  if (req.query.key !== ADMIN_KEY) return res.status(401).send("unauthorized");
  try {
    const result = await generateNextWeekWithGPT(getWeekAndDayJST);
    res.json({ ok: true, result });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

/** スロットPush送信（Usersの全UserIdへ送信） ?slot=朝/昼/夜/就寝 */
router.get("/admin/push-slot", async (req, res) => {
  if (req.query.key !== ADMIN_KEY) return res.status(401).send("unauthorized");
  const slot = (req.query.slot || "").trim() || "昼";
  try {
    await pushSlot(slot); // ★ 必ず await。バックグラウンド化させない
    res.json({ ok: true, slot });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

/** 今日の行抽出（デバッグ） */
router.get("/debug-today", async (_req, res) => {
  try {
    const { week, day } = getWeekAndDayJST(process.env.START_DATE);
    const { rows, idx, headers } = await loadMealPlan();
    const matches = rows
      .filter(
        (r) =>
          String(r._rawData[idx.Week]).trim() === String(week) &&
          String(r._rawData[idx.Day]).trim().toLowerCase() === day.toLowerCase()
      )
      .map((r) => r._rawData);
    res.json({ target: { week, day }, headers, hitCount: matches.length, matches });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

module.exports = router;
