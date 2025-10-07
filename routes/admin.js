// routes/admin.js
const express = require("express");
const router = express.Router();

const ADMIN_KEY = process.env.ADMIN_KEY || "";

const { getWeekAndDayJST } = require("../lib/utils");
const { loadMealPlan, getAllUserIds } = require("../lib/sheets");
const { generateNextWeekWithGPT } = require("../lib/llm");
const { pushSlot } = require("../services/scheduler");

router.get("/", (_req, res) => res.send("LINE Fitness Bot OK"));

router.get("/debug-week", (_req, res) => {
  try {
    const data = getWeekAndDayJST(process.env.START_DATE);
    res.json({ START_DATE: process.env.START_DATE, ...data });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

router.get("/admin/today", async (req, res) => {
  if (req.query.key !== ADMIN_KEY) return res.status(401).send("unauthorized");
  try {
    const { sheet, rows } = await loadMealPlan();
    res.json({ ok: true, sheetTitle: sheet.title, rowCount: rows.length });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

router.get("/admin/auto-gen", async (req, res) => {
  if (req.query.key !== ADMIN_KEY) return res.status(401).send("unauthorized");
  try {
    const result = await generateNextWeekWithGPT(getWeekAndDayJST);
    res.json({ ok: true, result });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

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

/** ✅ REST直読み版のdebug-users */
router.get("/admin/debug-users", async (req, res) => {
  if (req.query.key !== ADMIN_KEY) return res.status(401).send("unauthorized");
  try {
    const ids = await require("../lib/sheets").getAllUserIds();
    res.json({
      ok: true,
      validUserCount: ids.length,
      validUserIds: ids,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

module.exports = router;
