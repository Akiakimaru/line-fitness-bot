// マイページ専用JavaScript - LINE Fitness Bot

// URLパラメータを取得
const params = getUrlParams();
const { uid, exp, sig } = params;

console.log('MyPage params:', { uid, exp, sig });

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
    
    const [summary, logs] = await Promise.all([
      apiCall(`/user/summary?uid=${encodeURIComponent(uid)}&exp=${encodeURIComponent(exp)}&sig=${encodeURIComponent(sig)}`),
      apiCall(`/user/logs?uid=${encodeURIComponent(uid)}&exp=${encodeURIComponent(exp)}&sig=${encodeURIComponent(sig)}&days=8`)
    ]);
    
    console.log('API responses:', { summary, logs });
    
    if (!summary.ok) {
      throw new Error('summary failed: ' + (summary.error || 'Unknown error'));
    }
    if (!logs.ok) {
      throw new Error('logs failed: ' + (logs.error || 'Unknown error'));
    }
    
    // KPI更新
    document.getElementById('meal-count').textContent = summary.meals;
    document.getElementById('gym-count').textContent = summary.gymSets;
    document.getElementById('weight-count').textContent = logs.logs.filter(l => l.Kind === 'Weight').length;
    
    // PFCサマリー計算
    const mealLogs = logs.logs.filter(l => l.Kind === 'Meal' && l.PFC && l.PFC.total);
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
    logs.logs.forEach(log => {
      const logDate = new Date(log.DateTime).toDateString();
      recentDays.add(logDate);
    });
    document.getElementById('streak-days').textContent = recentDays.size;
    
    // ログ表示（最新順にソート）
    const tbody = document.getElementById('logs-tbody');
    tbody.innerHTML = '';
    
    if (logs.logs.length === 0) {
      updateStatus('status-message', '記録がありません。LINE Botで記録を開始しましょう！', 'warning');
    } else {
      updateStatus('status-message', 'データ読み込み完了', 'good');
      document.getElementById('logs-table').style.display = 'table';
      
      // 最新順にソート（DateTime降順）
      const sortedLogs = logs.logs.sort((a, b) => new Date(b.DateTime) - new Date(a.DateTime));
      
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

// 初期読み込み
loadData();
