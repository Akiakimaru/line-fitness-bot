// routes/admin.js
const express = require("express");
const router = express.Router();

const ADMIN_KEY = process.env.ADMIN_KEY || "";

const { getWeekAndDayJST } = require("../lib/utils");
const { loadMealPlan, readUsersDetailed, readRecentLogs } = require("../lib/sheets");
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

/* ✅ 追加：Users 一覧（詳細） */
router.get("/admin/users", async (req, res) => {
  if (req.query.key !== ADMIN_KEY) return res.status(401).send("unauthorized");
  try {
    const users = await readUsersDetailed();
    res.json({ ok: true, users });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

/* ✅ 追加：最近のログ */
router.get("/admin/logs", async (req, res) => {
  if (req.query.key !== ADMIN_KEY) return res.status(401).send("unauthorized");
  const days = Math.max(1, Math.min(31, parseInt(req.query.days || "7", 10) || 7));
  try {
    const logs = await readRecentLogs(days);
    res.json({ ok: true, days, logs });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

/* ✅ 追加：ダッシュボード統計 */
router.get("/admin/stats", async (req, res) => {
  if (req.query.key !== ADMIN_KEY) return res.status(401).send("unauthorized");
  try {
    const { week, day } = getWeekAndDayJST(process.env.START_DATE);
    const users = await readUsersDetailed();
    const recentLogs = await readRecentLogs(7);
    const { rows, idx } = await loadMealPlan();

    const todayRows = rows.filter(
      (r) => String(r._rawData[idx.Week]).trim() === String(week) &&
             String(r._rawData[idx.Day]).trim().toLowerCase() === day.toLowerCase()
    );
    const mealsToday = todayRows.filter((r) => String(r._rawData[idx.Kind]).trim() === "Meal").length;
    const trainingsToday = todayRows.filter((r) => String(r._rawData[idx.Kind]).trim() === "Training").length;

    const nextWeek = week + 1;
    const nextRows = rows.filter((r) => String(r._rawData[idx.Week]).trim() === String(nextWeek));
    const countMeal = nextRows.filter((r) => String(r._rawData[idx.Kind]).trim() === "Meal").length;
    const countTrain = nextRows.filter((r) => String(r._rawData[idx.Kind]).trim() === "Training").length;

    res.json({
      ok: true,
      now: { week, day },
      users: { count: users.length },
      logs7d: { count: recentLogs.length },
      today: { rows: todayRows.length, meals: mealsToday, trainings: trainingsToday },
      nextWeek: {
        week: nextWeek,
        total: nextRows.length,
        meal: countMeal,
        training: countTrain,
        complete35: nextRows.length === 35 && countMeal === 28 && countTrain === 7,
      },
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

/* ✅ 追加：ダッシュボード（簡易HTML） */
router.get("/admin/dashboard", (req, res) => {
  if (req.query.key !== ADMIN_KEY) return res.status(401).send("unauthorized");
  const key = String(req.query.key || "");
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");
  res.send(`<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>LINE Fitness 管理ダッシュボード</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica, Arial, "Hiragino Kaku Gothic ProN", Meiryo, sans-serif; margin: 20px; }
    h1 { font-size: 20px; margin-bottom: 8px; }
    section { margin: 16px 0; }
    table { border-collapse: collapse; width: 100%; }
    th, td { border: 1px solid #ddd; padding: 6px 8px; font-size: 13px; }
    th { background: #fafafa; text-align: left; }
    .kpi { display: flex; gap: 12px; flex-wrap: wrap; }
    .card { border: 1px solid #eee; padding: 10px 12px; border-radius: 6px; background: #fff; }
    code { background: #f5f5f5; padding: 2px 4px; border-radius: 3px; }
  </style>
</head>
<body>
  <h1>LINE Fitness 管理ダッシュボード</h1>
  <div class="kpi">
    <div class="card" id="kpi-now">Now</div>
    <div class="card" id="kpi-users">Users</div>
    <div class="card" id="kpi-logs">Logs(7d)</div>
    <div class="card" id="kpi-next">NextWeek</div>
  </div>

  <section>
    <h2>Users</h2>
    <table id="users-table"><thead><tr><th>UserId</th><th>DisplayName</th><th>StartDate</th><th>LastActive</th></tr></thead><tbody></tbody></table>
  </section>

  <section>
    <h2>Recent Logs (7d)</h2>
    <table id="logs-table"><thead><tr><th>DateTime</th><th>UserId</th><th>Kind</th><th>Text</th></tr></thead><tbody></tbody></table>
  </section>

  <section>
    <h2>Operations</h2>
    <div>今日のメニュー: <a href="/admin/today?key=${esc(key)}" target="_blank">/admin/today</a></div>
    <div>次週検証: <a href="/admin/nextweek-validate?key=${esc(key)}" target="_blank">/admin/nextweek-validate</a></div>
    <div>次週自動生成: <a href="/admin/auto-gen?key=${esc(key)}" target="_blank">/admin/auto-gen</a></div>
    <div>スロットPush: <code>/admin/push-slot?slot=昼&key=${esc(key)}</code></div>
  </section>

  <script>
    const key = ${JSON.stringify(key)};
    async function j(url){ const r = await fetch(url); if(!r.ok) throw new Error('HTTP '+r.status); return r.json(); }
    function td(v){ const d = document.createElement('td'); d.textContent = v; return d; }
    function tr(cells){ const tr = document.createElement('tr'); cells.forEach(c=>tr.appendChild(td(c))); return tr; }
    (async () => {
      try {
        const [stats, users, logs] = await Promise.all([
          j(`/admin/stats?key=${esc(key)}`),
          j(`/admin/users?key=${esc(key)}`),
          j(`/admin/logs?key=${esc(key)}&days=7`),
        ]);
        document.getElementById('kpi-now').textContent = `Week ${stats.now.week} / ${stats.now.day}`;
        document.getElementById('kpi-users').textContent = `Users ${stats.users.count}`;
        document.getElementById('kpi-logs').textContent = `Logs(7d) ${stats.logs7d.count}`;
        document.getElementById('kpi-next').textContent = `Next ${stats.nextWeek.week} | ${stats.nextWeek.total} rows ${stats.nextWeek.complete35 ? '✅' : '⚠️'}`;

        const utb = document.querySelector('#users-table tbody');
        users.users.forEach(u=>{
          utb.appendChild(tr([u.UserId, u.DisplayName, u.StartDate, u.LastActive]));
        });

        const ltb = document.querySelector('#logs-table tbody');
        logs.logs.slice(0, 200).forEach(r=>{
          ltb.appendChild(tr([r.DateTime, r.UserId, r.Kind, r.Text]));
        });
      } catch (e) {
        alert('Load failed: '+e.message);
      }
    })();
  </script>
</body>
</html>`);
});

module.exports = router;
