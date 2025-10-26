// マイページ専用JavaScript - LINE Fitness Bot

// URLパラメータを取得
const params = getUrlParams();
const { uid, exp, sig } = params;

console.log('MyPage params:', { uid, exp, sig });

// デバッグ情報を表示
if (!uid || !exp || !sig) {
  showDebugInfo('URLパラメータが不足しています', { uid, exp, sig });
}

/**
 * LINE Botの説明を表示
 */
function openLineBot() {
  alert('LINE Botで「マイページ」と送信すると、このページにアクセスできます。');
}

/**
 * 今日のメニューの説明を表示
 */
function showTodayMenu() {
  alert('LINE Botで「今日のメニュー」と送信すると、当日のメニューが表示されます。');
}

/**
 * ジムメニューを開く
 */
function openGymMenu() {
  if (!uid || !exp || !sig) {
    alert('URLパラメータが不足しています。');
    return;
  }
  const url = `/gym-menu?uid=${encodeURIComponent(uid)}&exp=${encodeURIComponent(exp)}&sig=${encodeURIComponent(sig)}`;
  window.open(url, '_blank');
}

/**
 * 管理画面を開く
 */
function openAdminPanel() {
  const adminKey = prompt('管理画面にアクセスするには管理者キーが必要です。\\n管理者キーを入力してください:');
  if (adminKey) {
    window.open(`/admin?key=${encodeURIComponent(adminKey)}`, '_blank');
  }
}

/**
 * デバッグページを開く（パラメータを引き継ぐ）
 */
function openDebugPage() {
  if (!uid || !exp || !sig) {
    alert('URLパラメータが不足しています。');
    return;
  }
  const url = `/debug.html?uid=${encodeURIComponent(uid)}&exp=${encodeURIComponent(exp)}&sig=${encodeURIComponent(sig)}`;
  window.open(url, '_blank');
}

/**
 * 買い出し計画を開く
 */
function openShoppingPlan() {
  if (!uid || !exp || !sig) {
    alert('URLパラメータが不足しています。');
    return;
  }
  const url = `/shopping-plan-view?uid=${encodeURIComponent(uid)}&exp=${encodeURIComponent(exp)}&sig=${encodeURIComponent(sig)}`;
  window.open(url, '_blank');
}

/**
 * 使い方ガイドを開く
 */
function openGuide() {
  if (!uid || !exp || !sig) {
    alert('URLパラメータが不足しています。');
    return;
  }
  const url = `/guide?uid=${encodeURIComponent(uid)}&exp=${encodeURIComponent(exp)}&sig=${encodeURIComponent(sig)}`;
  window.open(url, '_blank');
}

/**
 * 食品データベースを開く
 */
function openFoodDB() {
  if (!uid || !exp || !sig) {
    alert('URLパラメータが不足しています。');
    return;
  }
  const url = `/food-db?uid=${encodeURIComponent(uid)}&exp=${encodeURIComponent(exp)}&sig=${encodeURIComponent(sig)}`;
  window.open(url, '_blank');
}

/**
 * データを再読み込み
 */
function refreshData() {
  loadData();
}

/**
 * メインデータ読み込み関数
 */
async function loadData() {
  try {
    updateStatus('status-message', 'データ読み込み中...', 'info');
    
    if (!uid || !exp || !sig) {
      throw new Error('URLパラメータが不足しています: uid=' + uid + ', exp=' + exp + ', sig=' + sig);
    }
    
    console.log('Loading data for uid:', uid);
    
    const summaryUrl = `/user/summary?uid=${encodeURIComponent(uid)}&exp=${encodeURIComponent(exp)}&sig=${encodeURIComponent(sig)}`;
    const logsUrl = `/user/logs?uid=${encodeURIComponent(uid)}&exp=${encodeURIComponent(exp)}&sig=${encodeURIComponent(sig)}&days=8`;
    
    console.log('API URLs:', { summaryUrl, logsUrl });
    
    const [summary, logs] = await Promise.all([
      apiCall(summaryUrl),
      apiCall(logsUrl)
    ]);
    
    console.log('API responses:', { summary, logs });
    console.log('Summary ok:', summary.ok, 'Logs ok:', logs.ok);
    
    if (!summary.ok) {
      throw new Error('summary failed: ' + (summary.error || 'Unknown error'));
    }
    if (!logs.ok) {
      throw new Error('logs failed: ' + (logs.error || 'Unknown error'));
    }
    
    // KPI更新
    console.log('Updating KPIs:', { 
      meals: summary.data?.meals, 
      gymSets: summary.data?.gymSets, 
      weightCount: logs.data?.logs?.filter(l => l.Kind === 'Weight').length 
    });
    
    document.getElementById('meal-count').textContent = summary.data?.meals || 0;
    document.getElementById('gym-count').textContent = summary.data?.gymSets || 0;
    document.getElementById('weight-count').textContent = logs.data?.logs?.filter(l => l.Kind === 'Weight').length || 0;
    
    // グラフ描画
    renderCharts(logs, summary);
    
    // PFCサマリー計算
    const mealLogs = logs.data?.logs?.filter(l => l.Kind === 'Meal' && l.PFC && l.PFC.total) || [];
    let totalProtein = 0, totalFat = 0, totalCarbs = 0, totalCalories = 0;
    mealLogs.forEach(log => {
      if (log.PFC && log.PFC.total) {
        totalProtein += log.PFC.total.protein || 0;
        totalFat += log.PFC.total.fat || 0;
        totalCarbs += log.PFC.total.carbs || 0;
        totalCalories += log.PFC.total.calories || 0;
      }
    });
    
    // PFCサマリーを表示（簡易版）
    if (mealLogs.length > 0) {
      const pfcSummary = document.createElement('div');
      pfcSummary.innerHTML = 
        '<div style="background: #e8f5e8; padding: 12px; border-radius: 8px; margin: 12px 0; font-size: 12px;">' +
          '<strong>📊 7日間PFC合計</strong><br>' +
          'P: ' + totalProtein.toFixed(1) + 'g | F: ' + totalFat.toFixed(1) + 'g | C: ' + totalCarbs.toFixed(1) + 'g<br>' +
          'カロリー: ' + totalCalories.toFixed(0) + 'kcal (平均: ' + (totalCalories/7).toFixed(0) + 'kcal/日)' +
        '</div>';
      document.querySelector('.logs-section').insertBefore(pfcSummary, document.getElementById('status-message'));
    }
    
    // 連続記録日数（簡易版）
    const today = new Date();
    const recentDays = new Set();
    (logs.data?.logs || []).forEach(log => {
      const logDate = new Date(log.DateTime).toDateString();
      recentDays.add(logDate);
    });
    document.getElementById('streak-days').textContent = recentDays.size;
    
    // ログ表示（最新順にソート）
    const tbody = document.getElementById('logs-tbody');
    tbody.innerHTML = '';
    
    if ((logs.data?.logs || []).length === 0) {
      updateStatus('status-message', '記録がありません。LINE Botで記録を開始しましょう！', 'warning');
    } else {
      updateStatus('status-message', 'データ読み込み完了', 'good');
      document.getElementById('logs-table').style.display = 'table';
      
      // 最新順にソート（DateTime降順）
      const sortedLogs = (logs.data?.logs || []).sort((a, b) => new Date(b.DateTime) - new Date(a.DateTime));
      
      sortedLogs.slice(0, 30).forEach(r => {
        const tr = document.createElement('tr');
        const td1 = document.createElement('td'); 
        td1.textContent = formatJST(r.DateTime); 
        tr.appendChild(td1);
        
        const td2 = document.createElement('td'); 
        const kindEmoji = r.Kind === 'Meal' ? '🍽' : r.Kind === 'Gym' ? '💪' : '⚖️';
        td2.textContent = kindEmoji + ' ' + r.Kind; 
        tr.appendChild(td2);
        
        const td3 = document.createElement('td'); 
        let content = r.Text;
        // PFC情報がある場合は追加表示
        if (r.Kind === 'Meal' && r.PFC && r.PFC.total) {
          const { protein, fat, carbs, calories } = r.PFC.total;
          content += '\n📊 P' + protein + 'g F' + fat + 'g C' + carbs + 'g (' + calories + 'kcal)';
        }
        td3.textContent = content; 
        tr.appendChild(td3);
        
        tbody.appendChild(tr);
      });
    }
    
  } catch (error) {
    handleError(error, 'loadData');
    updateStatus('status-message', 'データの読み込みに失敗しました: ' + error.message, 'warning');
  }
}

/**
 * グラフ描画
 */
let weightChartInstance = null;
let pfcChartInstance = null;

function renderCharts(logs, summary) {
  renderWeightChart(logs);
  renderPFCChart(logs);
  renderGymHeatmap(logs);
}

/**
 * 体重推移グラフ
 */
function renderWeightChart(logs) {
  const ctx = document.getElementById('weightChart');
  if (!ctx) return;
  
  // 体重データを抽出（30日間）
  const weightLogs = (logs.data?.logs || [])
    .filter(l => l.Kind === 'Weight')
    .sort((a, b) => new Date(a.DateTime) - new Date(b.DateTime))
    .slice(-30);
  
  const labels = weightLogs.map(l => {
    const date = new Date(l.DateTime);
    return `${date.getMonth() + 1}/${date.getDate()}`;
  });
  
  const data = weightLogs.map(l => parseFloat(l.Text));
  
  // 既存のチャートを破棄
  if (weightChartInstance) {
    weightChartInstance.destroy();
  }
  
  weightChartInstance = new Chart(ctx, {
    type: 'line',
    data: {
      labels: labels,
      datasets: [{
        label: '体重 (kg)',
        data: data,
        borderColor: '#F59E0B',
        backgroundColor: 'rgba(245, 158, 11, 0.1)',
        tension: 0.4,
        fill: true,
        pointRadius: 4,
        pointHoverRadius: 6,
        pointBackgroundColor: '#F59E0B',
        pointBorderColor: '#fff',
        pointBorderWidth: 2
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          display: false
        },
        tooltip: {
          backgroundColor: 'rgba(0, 0, 0, 0.8)',
          padding: 12,
          titleFont: { size: 14 },
          bodyFont: { size: 13 },
          callbacks: {
            label: function(context) {
              return `体重: ${context.parsed.y.toFixed(1)} kg`;
            }
          }
        }
      },
      scales: {
        y: {
          beginAtZero: false,
          ticks: {
            callback: function(value) {
              return value + ' kg';
            }
          },
          grid: {
            color: 'rgba(0, 0, 0, 0.05)'
          }
        },
        x: {
          grid: {
            display: false
          }
        }
      }
    }
  });
}

/**
 * PFC推移グラフ（週間）
 */
function renderPFCChart(logs) {
  const ctx = document.getElementById('pfcChart');
  if (!ctx) return;
  
  // 過去7日間の日付を生成
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const date = new Date();
    date.setDate(date.getDate() - i);
    days.push(date);
  }
  
  const labels = days.map(d => `${d.getMonth() + 1}/${d.getDate()}`);
  
  // 各日のPFCを集計
  const proteinData = [];
  const fatData = [];
  const carbData = [];
  
  days.forEach(day => {
    const dayStr = day.toISOString().split('T')[0];
    const dayLogs = (logs.data?.logs || []).filter(l => {
      if (l.Kind !== 'Meal') return false;
      const logDate = new Date(l.DateTime).toISOString().split('T')[0];
      return logDate === dayStr;
    });
    
    let totalP = 0, totalF = 0, totalC = 0;
    dayLogs.forEach(log => {
      if (log.PFC && log.PFC.total) {
        totalP += log.PFC.total.protein || 0;
        totalF += log.PFC.total.fat || 0;
        totalC += log.PFC.total.carbs || 0;
      }
    });
    
    proteinData.push(totalP);
    fatData.push(totalF);
    carbData.push(totalC);
  });
  
  // 既存のチャートを破棄
  if (pfcChartInstance) {
    pfcChartInstance.destroy();
  }
  
  pfcChartInstance = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: labels,
      datasets: [
        {
          label: 'タンパク質 (g)',
          data: proteinData,
          backgroundColor: 'rgba(59, 130, 246, 0.8)',
          borderRadius: 6
        },
        {
          label: '脂質 (g)',
          data: fatData,
          backgroundColor: 'rgba(245, 158, 11, 0.8)',
          borderRadius: 6
        },
        {
          label: '炭水化物 (g)',
          data: carbData,
          backgroundColor: 'rgba(16, 185, 129, 0.8)',
          borderRadius: 6
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          position: 'top',
          labels: {
            boxWidth: 12,
            font: { size: 11 }
          }
        },
        tooltip: {
          backgroundColor: 'rgba(0, 0, 0, 0.8)',
          padding: 12
        }
      },
      scales: {
        y: {
          beginAtZero: true,
          stacked: false,
          grid: {
            color: 'rgba(0, 0, 0, 0.05)'
          }
        },
        x: {
          stacked: false,
          grid: {
            display: false
          }
        }
      }
    }
  });
}

/**
 * ジムアクティビティヒートマップ
 */
function renderGymHeatmap(logs) {
  const container = document.getElementById('gym-heatmap');
  if (!container) return;
  
  // 過去30日間の日付を生成
  const days = [];
  for (let i = 29; i >= 0; i--) {
    const date = new Date();
    date.setDate(date.getDate() - i);
    days.push(date);
  }
  
  // 各日のジム記録をカウント
  const gymCounts = {};
  days.forEach(day => {
    const dayStr = day.toISOString().split('T')[0];
    const dayGymLogs = (logs.data?.logs || []).filter(l => {
      if (l.Kind !== 'Gym') return false;
      const logDate = new Date(l.DateTime).toISOString().split('T')[0];
      return logDate === dayStr;
    });
    gymCounts[dayStr] = dayGymLogs.length;
  });
  
  // ヒートマップを描画
  container.innerHTML = '';
  
  // 曜日ラベル
  const weekDays = ['日', '月', '火', '水', '木', '金', '土'];
  
  days.forEach(day => {
    const dayStr = day.toISOString().split('T')[0];
    const count = gymCounts[dayStr] || 0;
    
    // 強度に応じた色
    let bgColor = 'bg-gray-100';
    let textColor = 'text-gray-400';
    let tooltip = '記録なし';
    
    if (count > 0) {
      bgColor = 'bg-green-200';
      textColor = 'text-green-800';
      tooltip = `${count}回`;
    }
    if (count >= 2) {
      bgColor = 'bg-green-400';
      textColor = 'text-white';
    }
    if (count >= 3) {
      bgColor = 'bg-green-600';
      textColor = 'text-white';
    }
    
    const cell = document.createElement('div');
    cell.className = `${bgColor} ${textColor} rounded-lg p-3 text-center text-xs font-semibold hover:scale-110 transition-transform cursor-pointer`;
    cell.title = `${day.getMonth() + 1}/${day.getDate()} (${weekDays[day.getDay()]}): ${tooltip}`;
    cell.innerHTML = `
      <div class="text-[10px] opacity-75">${day.getDate()}</div>
      <div class="text-lg">${count > 0 ? '💪' : '·'}</div>
    `;
    
    container.appendChild(cell);
  });
}

// 初期読み込み
loadData();
