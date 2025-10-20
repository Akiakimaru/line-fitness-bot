// routes/admin.js
const express = require("express");
const router = express.Router();

const ADMIN_KEY = process.env.ADMIN_KEY || "";

const { getWeekAndDayJST } = require("../lib/utils");
const { loadMealPlan } = require("../lib/sheets");
const { generateNextWeekWithGPT } = require("../lib/llm");
const { pushSlot } = require("../services/scheduler");
const { getTodayMenuText } = require("../services/lineHandlers");

// 既存
router.get("/", (_req, res) => res.send("LINE Fitness Bot OK"));
router.get("/debug-week", (_req, res) => {
  try {
    const data = getWeekAndDayJST(process.env.START_DATE);
    res.json({ START_DATE: process.env.START_DATE, ...data });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// 既存
router.get("/admin/today", async (req, res) => {
  if (req.query.key !== ADMIN_KEY) return res.status(401).send("unauthorized");
  try {
    const text = await getTodayMenuText();
    res.json({ ok: true, text });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// 既存（即時生成）
router.get("/admin/auto-gen", async (req, res) => {
  if (req.query.key !== ADMIN_KEY) return res.status(401).send("unauthorized");
  try {
    const result = await generateNextWeekWithGPT(getWeekAndDayJST);
    res.json({ ok: true, result });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// 既存（push手動）
router.get("/admin/push-slot", async (req, res) => {
  if (req.query.key !== ADMIN_KEY) return res.status(401).send("unauthorized");
  const slot = (req.query.slot || "").trim() || "昼";
  try {
    await pushSlot(slot);
    res.json({ ok: true, slot });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

/* ✅ 追加：次週検証（35行揃っているか） */
router.get("/admin/nextweek-validate", async (req, res) => {
  if (req.query.key !== ADMIN_KEY) return res.status(401).send("unauthorized");
  try {
    const { week } = getWeekAndDayJST(process.env.START_DATE);
    const target = week + 1;

    const { rows, idx } = await loadMealPlan();
    const nextRows = rows.filter(
      (r) => String(r._rawData[idx.Week]).trim() === String(target)
    );

    const countMeal = nextRows.filter((r) => String(r._rawData[idx.Kind]).trim() === "Meal").length;
    const countTrain = nextRows.filter((r) => String(r._rawData[idx.Kind]).trim() === "Training").length;

    res.json({
      ok: true,
      targetWeek: target,
      total: nextRows.length,
      meal: countMeal,
      training: countTrain,
      complete35: nextRows.length === 35 && countMeal === 28 && countTrain === 7,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

module.exports = router;
