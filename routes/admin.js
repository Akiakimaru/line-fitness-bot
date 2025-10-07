// routes/admin.js
const express = require("express");
const router = express.Router();

const ADMIN_KEY = process.env.ADMIN_KEY || "";

// libs / services
const { getWeekAndDayJST } = require("../lib/utils");
const { loadMealPlan, getAllUserIds, dedupeUsers } = require("../lib/sheets");
const { generateNextWeekWithGPT } = require("../lib/llm");
const { pushSlot } = require("../services/scheduler");
const { getTodayMenuText } = require("../services/lineHandlers"); // for /admin/today

/* =========================
 * Health / Debug
 * ======================= */
router.get("/", (_req, res) => res.send("LINE Fitness Bot OK"));

router.get("/debug-week", (_req, res) => {
  try {
    const data = getWeekAndDayJST(process.env.START_DATE);
    res.json({ START_DATE: process.env.START_DATE, ...data });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

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

/* =========================
 * Admin (key required)
 * ======================= */
router.get("/admin/today", async (req, res) => {
  if (req.query.key !== ADMIN_KEY) return res.status(401).send("unauthorized");
  try {
    const text = await getTodayMenuText();
    res.json({ ok: true, text });
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
    await pushSlot(slot); // MUST await
    res.json({ ok: true, slot });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

router.get("/admin/debug-users", async (req, res) => {
  if (req.query.key !== ADMIN_KEY) return res.status(401).send("unauthorized");
  try {
    const ids = await getAllUserIds();
    res.json({
      ok: true,
      validUserCount: ids.length,
      validUserIds: ids,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

/** 重複ユーザーを物理削除してユニーク化（メンテ用・手動実行） */
router.get("/admin/dedupe-users", async (req, res) => {
  if (req.query.key !== ADMIN_KEY) return res.status(401).send("unauthorized");
  try {
    await dedupeUsers();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

module.exports = router;
