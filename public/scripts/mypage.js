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
 * ジムログ用の日付換算（AM5時基準）- クライアント側
 * AM5:00〜翌日AM4:59までを同じ日として換算
 */
function convertToGymDateClient(dateTime) {
  const dt = new Date(dateTime);
  
  // 時刻が0:00〜4:59の場合は前日扱い
  const hour = dt.getHours();
  if (hour < 5) {
    dt.setDate(dt.getDate() - 1);
  }
  
  // YYYY-MM-DD形式で返す
  return dt.toISOString().split('T')[0];
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
  
  // 各日のジム記録をカウント（AM5時基準で換算）
  const gymCounts = {};
  days.forEach(day => {
    const dayStr = day.toISOString().split('T')[0];
    const dayGymLogs = (logs.data?.logs || []).filter(l => {
      if (l.Kind !== 'Gym') return false;
      // AM5時基準で日付を換算
      const gymDate = convertToGymDateClient(l.DateTime);
      return gymDate === dayStr;
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
    cell.dataset.date = dayStr; // 日付をdata属性に保存
    cell.innerHTML = `
      <div class="text-[10px] opacity-75">${day.getDate()}</div>
      <div class="text-lg">${count > 0 ? '💪' : '·'}</div>
    `;
    
    // クリックイベント（記録がある場合のみ）
    if (count > 0) {
      cell.addEventListener('click', () => showGymDetail(dayStr));
    }
    
    container.appendChild(cell);
  });
}

/**
 * ジムログ詳細モーダルを表示
 */
async function showGymDetail(date) {
  try {
    const params = new URLSearchParams(window.location.search);
    const uid = params.get('uid');
    const exp = params.get('exp');
    const sig = params.get('sig');
    
    console.log(`[showGymDetail] Fetching detail for date: ${date}`);
    
    // APIから詳細データを取得
    const response = await fetch(`/user/gym-detail?uid=${uid}&exp=${exp}&sig=${sig}&date=${date}`);
    const result = await response.json();
    
    if (!response.ok || !result.ok) {
      throw new Error(result.message || 'データの取得に失敗しました');
    }
    
    const data = result.data;
    console.log('[showGymDetail] Received data:', data);
    
    // モーダルを表示
    displayGymDetailModal(data);
    
  } catch (error) {
    console.error('[showGymDetail] Error:', error);
    alert('ジムログの詳細取得に失敗しました: ' + error.message);
  }
}

/**
 * ジムログ詳細モーダルの表示
 */
function displayGymDetailModal(data) {
  // 既存のモーダルを削除
  const existingModal = document.getElementById('gym-detail-modal');
  if (existingModal) {
    existingModal.remove();
  }
  
  // 日付を整形
  const dateObj = new Date(data.date + 'T00:00:00');
  const dateStr = `${dateObj.getMonth() + 1}月${dateObj.getDate()}日`;
  
  // モーダルHTML生成
  const modalHTML = `
    <div id="gym-detail-modal" class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm" onclick="closeGymDetailModal(event)">
      <div class="bg-white rounded-2xl shadow-2xl max-w-2xl w-full max-h-[90vh] overflow-y-auto" onclick="event.stopPropagation()">
        <!-- ヘッダー -->
        <div class="bg-gradient-to-r from-green-500 to-emerald-600 p-6 text-white rounded-t-2xl">
          <div class="flex justify-between items-center">
            <div>
              <h2 class="text-2xl font-bold">💪 ジムログ詳細</h2>
              <p class="text-green-100 mt-1">${dateStr}</p>
            </div>
            <button onclick="closeGymDetailModal()" class="text-white hover:bg-white/20 rounded-full p-2 transition-colors">
              <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>
              </svg>
            </button>
          </div>
        </div>
        
        <!-- サマリー -->
        <div class="p-6 border-b border-gray-200">
          <div class="grid grid-cols-2 gap-4">
            <div class="bg-gradient-to-br from-blue-50 to-blue-100 rounded-xl p-4">
              <div class="text-sm text-blue-600 font-medium">総セット数</div>
              <div class="text-3xl font-bold text-blue-700 mt-1">${data.totalSets}</div>
            </div>
            <div class="bg-gradient-to-br from-purple-50 to-purple-100 rounded-xl p-4">
              <div class="text-sm text-purple-600 font-medium">総トレ時間</div>
              <div class="text-3xl font-bold text-purple-700 mt-1">${data.totalMinutes}<span class="text-lg">分</span></div>
            </div>
          </div>
        </div>
        
        <!-- 種目別詳細 -->
        <div class="p-6">
          <h3 class="text-lg font-bold text-gray-800 mb-4">📋 実施種目</h3>
          ${data.exercises.length > 0 ? `
            <div class="space-y-3">
              ${data.exercises.map(ex => `
                <div class="bg-gradient-to-r from-gray-50 to-gray-100 rounded-xl p-4 border border-gray-200">
                  <div class="flex justify-between items-start">
                    <div class="flex-1">
                      <div class="font-bold text-gray-800">${ex.name}</div>
                      <div class="text-sm text-gray-600 mt-1">
                        ${ex.sets}セット
                        ${ex.avgReps ? ` · 平均${ex.avgReps}回` : ''}
                        ${ex.avgWeight ? ` · 平均${ex.avgWeight}kg` : ''}
                      </div>
                    </div>
                  </div>
                  ${ex.reps && ex.reps.length > 0 ? `
                    <div class="mt-2 flex flex-wrap gap-2">
                      ${ex.reps.map((rep, idx) => `
                        <span class="bg-white px-3 py-1 rounded-full text-xs font-medium text-gray-700 border border-gray-300">
                          ${rep}回${ex.weights && ex.weights[idx] ? ` × ${ex.weights[idx]}kg` : ''}
                        </span>
                      `).join('')}
                    </div>
                  ` : ''}
                </div>
              `).join('')}
            </div>
          ` : '<p class="text-gray-500 text-center py-8">種目データがありません</p>'}
        </div>
        
        <!-- 生ログ -->
        ${data.logs.length > 0 ? `
          <div class="p-6 bg-gray-50 rounded-b-2xl">
            <details class="cursor-pointer">
              <summary class="text-sm font-medium text-gray-700 hover:text-gray-900">📝 記録詳細を表示</summary>
              <div class="mt-4 space-y-3">
                ${data.logs.map((log, idx) => `
                  <div class="bg-white rounded-lg p-4 border border-gray-200">
                    <div class="text-xs text-gray-500 mb-2">記録${idx + 1} - ${new Date(log.dateTime).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}</div>
                    <div class="text-sm text-gray-800 whitespace-pre-wrap font-mono">${log.text}</div>
                    ${log.meta && (log.meta.sets || log.meta.minutes) ? `
                      <div class="text-xs text-gray-600 mt-2">
                        ${log.meta.sets ? `${log.meta.sets}セット` : ''} ${log.meta.minutes ? `${log.meta.minutes}分` : ''}
                      </div>
                    ` : ''}
                  </div>
                `).join('')}
              </div>
            </details>
          </div>
        ` : ''}
      </div>
    </div>
  `;
  
  document.body.insertAdjacentHTML('beforeend', modalHTML);
}

/**
 * ジムログ詳細モーダルを閉じる
 */
function closeGymDetailModal(event) {
  const modal = document.getElementById('gym-detail-modal');
  if (modal && (!event || event.target === modal)) {
    modal.remove();
  }
}

// グローバルに公開（HTML内のonclickから呼び出すため）
window.closeGymDetailModal = closeGymDetailModal;

// 初期読み込み
loadData();
