// routes/admin.js
const express = require("express");
const router = express.Router();

const { getWeekAndDayJST, TZ } = require("../lib/utils");
const { loadMealPlan, cell, appendLogs, getRecentLogs, chunkAddRows, doc } = require("../lib/sheets");
const { generateNextWeekWithGPT } = require("../lib/llm");

module.exports = function makeAdminRoutes(ADMIN_KEY, lineClient, getLastUserId, pushSlot) {
  // whoami
  router.get("/whoami", (_req, res) =>
    res.json({ userIdSet: !!getLastUserId(), lastUserId: getLastUserId() })
  );

  // debug-week
  router.get("/debug-week", (req, res) => {
    res.json({ START_DATE: process.env.START_DATE, ...getWeekAndDayJST(process.env.START_DATE) });
  });

  // debug-today
  router.get("/debug-today", async (_req, res) => {
    const t0 = Date.now();
    try {
      const { week, day } = getWeekAndDayJST(process.env.START_DATE);
      const { rows, idx, headers } = await loadMealPlan();
      const matches = rows
        .filter(
          (r) =>
            cell(r, idx.Week) === String(week) &&
            cell(r, idx.Day).toLowerCase() === day.toLowerCase()
        )
        .map((r) => r._rawData);
      res.json({
        target: { week, day },
        headers,
        hitCount: matches.length,
        matches,
        latencyMs: Date.now() - t0,
        sheetRowCount: rows.length,
      });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  // weeks histogram
  router.get("/admin/weeks", async (req, res) => {
    if (req.query.key !== ADMIN_KEY) return res.status(401).send("unauthorized");
    try {
      const { rows, idx } = await loadMealPlan();
      const hist = {};
      for (const r of rows) {
        const w = parseInt(cell(r, idx.Week) || "0", 10);
        if (!Number.isFinite(w) || w <= 0) continue;
        hist[w] = (hist[w] || 0) + 1;
      }
      const { week } = getWeekAndDayJST(process.env.START_DATE);
      res.json({ currentWeek: week, histogram: hist });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  // admin/auto-gen
  router.get("/admin/auto-gen", async (req, res) => {
    if (req.query.key !== ADMIN_KEY) return res.status(401).send("unauthorized");
    try {
      const result = await generateNextWeekWithGPT(getWeekAndDayJST);
      res.json({ ok: true, result });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e) });
    }
  });

  // admin/push-slot
  router.get("/admin/push-slot", async (req, res) => {
    if (req.query.key !== ADMIN_KEY) return res.status(401).send("unauthorized");
    const slot = req.query.slot || "昼";
    try {
      await pushSlot(slot);
      res.json({ ok: true, slot, to: getLastUserId() });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e) });
    }
  });

  // admin/logs-latest
  router.get("/admin/logs-latest", async (req, res) => {
    if (req.query.key !== ADMIN_KEY) return res.status(401).send("unauthorized");
    try {
      const days = Number.parseInt(req.query.days || "7", 10);
      const logs = await getRecentLogs(days);
      res.json({ ok: true, days, count: logs.length, logs });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e) });
    }
  });

  // admin/today
  const { getTodayMenuText } = require("../services/lineHandlers");
  router.get("/admin/today", async (req, res) => {
    if (req.query.key !== ADMIN_KEY) return res.status(401).send("unauthorized");
    try {
      const text = await getTodayMenuText();
      res.json({ ok: true, text });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e) });
    }
  });

  // admin/archive (keep & dry support)
  const { nowJST } = require("../lib/utils");
  router.get("/admin/archive", async (req, res) => {
    if (req.query.key !== ADMIN_KEY) return res.status(401).send("unauthorized");
    try {
      const keep = Number.isFinite(parseInt(req.query.keep, 10)) ? parseInt(req.query.keep, 10) : 4;
      const dry = req.query.dry === "1";

      const { rows, idx, headers, sheet } = await loadMealPlan();
      const { week } = getWeekAndDayJST(process.env.START_DATE);
      const cutoff = week - keep;

      const toMove = [];
      const toKeep = [];
      for (const r of rows) {
        const wStr = cell(r, idx.Week);
        const dStr = cell(r, idx.Day);
        if (wStr === "Week" && dStr === "Day") continue; // header-like, drop
        const w = parseInt(wStr || "0", 10);
        if (!Number.isFinite(w) || w <= 0) { toKeep.push(r); continue; }
        if (w <= cutoff) toMove.push(r); else toKeep.push(r);
      }

      if (dry) {
        return res.json({ ok: true, dryRun: true, keep, currentWeek: week, cutoff, candidate: toMove.length });
      }

      if (!toMove.length) return res.json({ ok: true, moved: 0, kept: toKeep.length, cutoff, week });

      const now = nowJST();
      const name = `Archive_${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}`;
      let archive = doc.sheetsByTitle[name];
      if (!archive) {
        archive = await doc.addSheet({ title: name, headerValues: headers });
      }

      const movePayload = toMove.map((r) => {
        const o = {};
        headers.forEach((h, i) => { o[h] = cell(r, i); });
        return o;
      });
      await chunkAddRows(archive, movePayload);

      const keepPayload = toKeep.map((r) => {
        const o = {};
        headers.forEach((h, i) => { o[h] = cell(r, i); });
        return o;
      });
      await sheet.clear();
      await sheet.setHeaderRow(headers);
      if (keepPayload.length) await chunkAddRows(sheet, keepPayload);

      res.json({ ok: true, moved: movePayload.length, kept: keepPayload.length, cutoff, week, archiveName: name });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e) });
    }
  });

  // 1-C: ENV check
  router.get("/admin/env-check", (req, res) => {
    if (req.query.key !== ADMIN_KEY) return res.status(401).send("unauthorized");
    const keys = [
      "LINE_CHANNEL_ACCESS_TOKEN",
      "LINE_CHANNEL_SECRET",
      "GOOGLE_SHEET_ID",
      "GOOGLE_SERVICE_ACCOUNT_JSON",
      "OPENAI_API_KEY",
      "START_DATE",
    ];
    const report = {};
    for (const k of keys) {
      const v = process.env[k] || "";
      report[k] = { set: !!v, sample: v ? (v.length > 12 ? v.slice(0, 6) + "..." : "***") : "" };
    }
    res.json({ ok: true, report });
  });

  return router;
};
