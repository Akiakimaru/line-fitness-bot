// routes/admin.js
const express = require("express");
const router = express.Router();

const ADMIN_KEY = process.env.ADMIN_KEY || "";

const { getWeekAndDayJST, verifyUserLink, signUserLink } = require("../lib/utils");
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
    console.error("[admin/users] Error:", e);
    res.status(500).json({ ok: false, error: String(e), stack: e.stack });
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
    console.error("[admin/logs] Error:", e);
    res.status(500).json({ ok: false, error: String(e), stack: e.stack });
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
    console.error("[admin/stats] Error:", e);
    res.status(500).json({ ok: false, error: String(e), stack: e.stack });
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
          j('/admin/stats?key=' + encodeURIComponent(key)),
          j('/admin/users?key=' + encodeURIComponent(key)),
          j('/admin/logs?key=' + encodeURIComponent(key) + '&days=7'),
        ]);
        
        if (!stats.ok) {
          throw new Error('Stats API failed: ' + (stats.error || 'Unknown error'));
        }
        if (!users.ok) {
          throw new Error('Users API failed: ' + (users.error || 'Unknown error'));
        }
        if (!logs.ok) {
          throw new Error('Logs API failed: ' + (logs.error || 'Unknown error'));
        }
        
        document.getElementById('kpi-now').textContent = 'Week ' + stats.now.week + ' / ' + stats.now.day;
        document.getElementById('kpi-users').textContent = 'Users ' + stats.users.count;
        document.getElementById('kpi-logs').textContent = 'Logs(7d) ' + stats.logs7d.count;
        document.getElementById('kpi-next').textContent = 'Next ' + stats.nextWeek.week + ' | ' + stats.nextWeek.total + ' rows ' + (stats.nextWeek.complete35 ? '✅' : '⚠️');

        const utb = document.querySelector('#users-table tbody');
        users.users.forEach(u=>{
          utb.appendChild(tr([u.UserId, u.DisplayName, u.StartDate, u.LastActive]));
        });

        const ltb = document.querySelector('#logs-table tbody');
        logs.logs.slice(0, 200).forEach(r=>{
          ltb.appendChild(tr([r.DateTime, r.UserId, r.Kind, r.Text]));
        });
      } catch (e) {
        console.error('Dashboard load error:', e);
        document.body.innerHTML = '<h1>LINE Fitness 管理ダッシュボード</h1><p style="color: red;">Load failed: ' + e.message + '</p><p>Check server logs for details.</p>';
      }
    })();
  </script>
</body>
</html>`);
});

/* ========= Public: user logs and summary (signed) ========= */
router.get("/user/logs", async (req, res) => {
  const { uid, exp, sig } = req.query;
  console.log("[user/logs] params:", { uid, exp, sig });
  const isValid = verifyUserLink(String(uid || ""), Number(exp), String(sig || ""));
  console.log("[user/logs] verify result:", isValid);
  if (!isValid) {
    return res.status(401).json({ ok: false, error: "unauthorized", debug: { uid, exp, sig } });
  }
  try {
    const days = Math.max(1, Math.min(31, parseInt(req.query.days || "7", 10) || 7));
    const logs = (await readRecentLogs(days)).filter(r => r.UserId === uid);
    res.json({ ok: true, uid, days, logs });
  } catch (e) {
    console.error("[user/logs] Error:", e);
    res.status(500).json({ ok: false, error: String(e) });
  }
});

router.get("/user/summary", async (req, res) => {
  const { uid, exp, sig } = req.query;
  console.log("[user/summary] params:", { uid, exp, sig });
  const isValid = verifyUserLink(String(uid || ""), Number(exp), String(sig || ""));
  console.log("[user/summary] verify result:", isValid);
  if (!isValid) {
    return res.status(401).json({ ok: false, error: "unauthorized", debug: { uid, exp, sig } });
  }
  try {
    const days = Math.max(1, Math.min(31, parseInt(req.query.days || "7", 10) || 7));
    const logs = (await readRecentLogs(days)).filter(r => r.UserId === uid);
    // simple summary
    let weights = [];
    let gymSets = 0, gymMinutes = 0;
    let meals = 0;
    for (const r of logs) {
      if (r.Kind === "Weight") {
        const v = parseFloat(r.Text);
        if (!Number.isNaN(v)) weights.push(v);
      } else if (r.Kind === "Gym") {
        const meta = r.Meta || {};
        if (Array.isArray(meta.parsed)) {
          for (const ex of meta.parsed) {
            if (Array.isArray(ex.sets)) gymSets += ex.sets.length;
            if (ex.minutes) gymMinutes += Number(ex.minutes) || 0;
          }
        }
      } else if (r.Kind === "Meal") {
        meals += 1;
      }
    }
    const wAvg = weights.length ? (weights.reduce((a,b)=>a+b,0)/weights.length) : null;
    const wMin = weights.length ? Math.min(...weights) : null;
    const wMax = weights.length ? Math.max(...weights) : null;
    res.json({ ok: true, uid, days, meals, gymSets, gymMinutes, weight: { avg: wAvg, min: wMin, max: wMax } });
  } catch (e) {
    console.error("[user/summary] Error:", e);
    res.status(500).json({ ok: false, error: String(e) });
  }
});

/* ========= Public: simple MyPage ========= */
router.get("/mypage", (req, res) => {
  const { uid, exp, sig } = req.query;
  console.log("[mypage] params:", { uid, exp, sig });
  const isValid = verifyUserLink(String(uid || ""), Number(exp), String(sig || ""));
  console.log("[mypage] verify result:", isValid);
  if (!isValid) {
    return res.status(401).send("unauthorized - check server logs for details");
  }
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");
  res.send(`<!doctype html>
<html lang="ja"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>MyPage - フィットネス管理</title>
<style>
  body{font-family:system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; padding:16px; background:#f5f5f5; margin:0}
  .container{max-width:600px; margin:0 auto; background:white; border-radius:12px; padding:20px; box-shadow:0 2px 10px rgba(0,0,0,0.1)}
  .header{text-align:center; margin-bottom:24px; padding-bottom:16px; border-bottom:2px solid #e0e0e0}
  .kpi-grid{display:grid; grid-template-columns:1fr 1fr; gap:12px; margin-bottom:24px}
  .kpi-card{background:#f8f9fa; padding:16px; border-radius:8px; text-align:center; border-left:4px solid #007bff}
  .kpi-card.meal{border-left-color:#28a745}
  .kpi-card.gym{border-left-color:#dc3545}
  .kpi-card.weight{border-left-color:#ffc107}
  .kpi-number{font-size:24px; font-weight:bold; color:#333}
  .kpi-label{font-size:12px; color:#666; margin-top:4px}
  .action-grid{display:grid; grid-template-columns:1fr 1fr; gap:12px; margin-bottom:24px}
  .action-btn{background:#007bff; color:white; border:none; padding:12px; border-radius:8px; font-size:14px; cursor:pointer; text-decoration:none; text-align:center; display:block}
  .action-btn:hover{background:#0056b3}
  .action-btn.secondary{background:#6c757d}
  .action-btn.secondary:hover{background:#545b62}
  .logs-section{margin-top:24px}
  .logs-table{width:100%; border-collapse:collapse; font-size:12px}
  .logs-table th, .logs-table td{border:1px solid #ddd; padding:8px; text-align:left}
  .logs-table th{background:#f8f9fa; font-weight:600}
  .logs-table tr:nth-child(even){background:#f8f9fa}
  .status-badge{display:inline-block; padding:2px 8px; border-radius:12px; font-size:10px; font-weight:600}
  .status-good{background:#d4edda; color:#155724}
  .status-warning{background:#fff3cd; color:#856404}
  .status-info{background:#d1ecf1; color:#0c5460}
  @media (max-width: 480px) {
    .kpi-grid, .action-grid{grid-template-columns:1fr}
    .container{padding:12px}
  }
</style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>📊 マイページ</h1>
      <p>フィットネス管理ダッシュボード</p>
    </div>
    
    <div id="kpi-grid" class="kpi-grid">
      <div class="kpi-card meal">
        <div class="kpi-number" id="meal-count">-</div>
        <div class="kpi-label">食事記録</div>
      </div>
      <div class="kpi-card gym">
        <div class="kpi-number" id="gym-count">-</div>
        <div class="kpi-label">ジム記録</div>
      </div>
      <div class="kpi-card weight">
        <div class="kpi-number" id="weight-count">-</div>
        <div class="kpi-label">体重記録</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-number" id="streak-days">-</div>
        <div class="kpi-label">連続記録日</div>
      </div>
    </div>
    
    <div class="action-grid">
      <a href="#" class="action-btn" onclick="openLineBot()">📱 LINE Bot</a>
      <a href="/hiit-plan.html" class="action-btn secondary">🚴‍♂️ HIITプラン</a>
      <a href="#" class="action-btn secondary" onclick="showTodayMenu()">🍽 今日のメニュー</a>
      <a href="#" class="action-btn secondary" onclick="refreshData()">🔄 更新</a>
    </div>
    
    <div class="logs-section">
      <h3>📝 最近の記録（7日間）</h3>
      <div id="status-message" class="status-badge status-info">データ読み込み中...</div>
      <table class="logs-table" id="logs-table" style="display:none">
        <thead><tr><th>日時</th><th>種別</th><th>内容</th></tr></thead>
        <tbody id="logs-tbody"></tbody>
      </table>
    </div>
  </div>
  
  <script>
    const qs = new URLSearchParams(window.location.search);
    const uid = qs.get('uid');
    const exp = qs.get('exp');
    const sig = qs.get('sig');
    
    async function j(u){ 
      const r = await fetch(u); 
      if(!r.ok) throw new Error('HTTP '+r.status); 
      return r.json(); 
    }
    
    function fmtJST(iso){
      try{
        const d = new Date(iso);
        if(isNaN(d.getTime())) return String(iso);
        // JST変換（timeZone指定で自動変換）
        return d.toLocaleString('ja-JP', { 
          timeZone: 'Asia/Tokyo', 
          hour12: false,
          year: 'numeric', 
          month: '2-digit', 
          day: '2-digit', 
          hour: '2-digit', 
          minute: '2-digit' 
        });
      }catch(_){ return String(iso); }
    }
    
    function updateStatus(message, type = 'info') {
      const statusEl = document.getElementById('status-message');
      statusEl.textContent = message;
      statusEl.className = 'status-badge status-' + type;
    }
    
    function openLineBot() {
      alert('LINE Botで「マイページ」と送信すると、このページにアクセスできます。');
    }
    
    function showTodayMenu() {
      alert('LINE Botで「今日のメニュー」と送信すると、当日のメニューが表示されます。');
    }
    
    function refreshData() {
      loadData();
    }
    
    async function loadData() {
      try {
        updateStatus('データ読み込み中...', 'info');
        
        const [summary, logs] = await Promise.all([
          j('/user/summary?uid='+encodeURIComponent(uid)+'&exp='+encodeURIComponent(exp)+'&sig='+encodeURIComponent(sig)),
          j('/user/logs?uid='+encodeURIComponent(uid)+'&exp='+encodeURIComponent(exp)+'&sig='+encodeURIComponent(sig)+'&days=8')
        ]);
        
        if(!summary.ok) throw new Error('summary failed');
        if(!logs.ok) throw new Error('logs failed');
        
        // KPI更新
        document.getElementById('meal-count').textContent = summary.meals;
        document.getElementById('gym-count').textContent = summary.gymSets;
        document.getElementById('weight-count').textContent = logs.logs.filter(l => l.Kind === 'Weight').length;
        
        // 連続記録日数（簡易版）
        const today = new Date();
        const recentDays = new Set();
        logs.logs.forEach(log => {
          const logDate = new Date(log.DateTime).toDateString();
          recentDays.add(logDate);
        });
        document.getElementById('streak-days').textContent = recentDays.size;
        
        // ログ表示（最新順にソート）
        const tbody = document.getElementById('logs-tbody');
        tbody.innerHTML = '';
        
        if(logs.logs.length === 0) {
          updateStatus('記録がありません。LINE Botで記録を開始しましょう！', 'warning');
        } else {
          updateStatus('データ読み込み完了', 'good');
          document.getElementById('logs-table').style.display = 'table';
          
          // 最新順にソート（DateTime降順）
          const sortedLogs = logs.logs.sort((a, b) => new Date(b.DateTime) - new Date(a.DateTime));
          
          sortedLogs.slice(0, 30).forEach(r => {
            const tr = document.createElement('tr');
            const td1 = document.createElement('td'); 
            td1.textContent = fmtJST(r.DateTime); 
            tr.appendChild(td1);
            
            const td2 = document.createElement('td'); 
            const kindEmoji = r.Kind === 'Meal' ? '🍽' : r.Kind === 'Gym' ? '💪' : '⚖️';
            td2.textContent = kindEmoji + ' ' + r.Kind; 
            tr.appendChild(td2);
            
            const td3 = document.createElement('td'); 
            td3.textContent = r.Text; 
            tr.appendChild(td3);
            
            tbody.appendChild(tr);
          });
        }
        
      } catch(e) {
        console.error('Load failed:', e);
        updateStatus('データの読み込みに失敗しました: ' + e.message, 'warning');
      }
    }
    
    // 初期読み込み
    loadData();
  </script>
</body></html>`);
});

module.exports = router;
