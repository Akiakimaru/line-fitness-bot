// ジムメニュー専用JavaScript - LINE Fitness Bot

// URLパラメータを取得
const params = getUrlParams();
const { uid, exp, sig } = params;

console.log('GymMenu params:', { uid, exp, sig });

/**
 * マイページに戻るボタンの設定
 */
function setupBackButton() {
  const backBtn = document.getElementById('back-btn');
  if (backBtn && uid && exp && sig) {
    backBtn.href = `/mypage?uid=${encodeURIComponent(uid)}&exp=${encodeURIComponent(exp)}&sig=${encodeURIComponent(sig)}`;
  }
}

/**
 * ジムメニューデータを読み込み
 */
async function loadGymMenus() {
  try {
    updateStatus('status-message', 'データ読み込み中...', 'info');
    
    if (!uid || !exp || !sig) {
      throw new Error('URLパラメータが不足しています');
    }
    
    const logs = await apiCall(`/user/logs?uid=${encodeURIComponent(uid)}&exp=${encodeURIComponent(exp)}&sig=${encodeURIComponent(sig)}&days=7`);
    
    if (!logs.ok) {
      throw new Error('logs failed: ' + (logs.error || 'Unknown error'));
    }
    
    const gymLogs = (logs.data?.logs || []).filter(l => l.Kind === 'Gym');
    
    const container = document.getElementById('menu-container');
    container.innerHTML = '';
    
    if (gymLogs.length === 0) {
      updateStatus('status-message', 'ジム記録がありません', 'warning');
      container.innerHTML = '<div class="no-data">💪 まだジム記録がありません<br>LINE Botでトレーニングを記録しましょう！</div>';
    } else {
      updateStatus('status-message', 'データ読み込み完了', 'info');
      
      // 日付順にソート（新しい順）
      const sortedLogs = gymLogs.sort((a, b) => new Date(b.DateTime) - new Date(a.DateTime));
      
      sortedLogs.forEach(log => {
        const menuCard = document.createElement('div');
        menuCard.className = 'menu-card';
        
        const date = document.createElement('div');
        date.className = 'menu-date';
        date.textContent = formatJST(log.DateTime);
        menuCard.appendChild(date);
        
        const content = document.createElement('div');
        content.className = 'menu-content';
        
        // メタデータから詳細情報を抽出
        if (log.Meta && log.Meta.parsed && Array.isArray(log.Meta.parsed)) {
          let menuText = '';
          log.Meta.parsed.forEach(exercise => {
            if (exercise.name) {
              menuText += '🏋️ ' + exercise.name;
              if (exercise.sets && Array.isArray(exercise.sets)) {
                menuText += ' (' + exercise.sets.length + 'セット)';
              }
              if (exercise.minutes) {
                menuText += ' - ' + exercise.minutes + '分';
              }
              menuText += '\\n';
            }
          });
          content.textContent = menuText || log.Text;
        } else {
          content.textContent = log.Text;
        }
        
        menuCard.appendChild(content);
        container.appendChild(menuCard);
      });
    }
    
  } catch (error) {
    handleError(error, 'loadGymMenus');
    updateStatus('status-message', 'データの読み込みに失敗しました: ' + error.message, 'warning');
  }
}

// 初期化
setupBackButton();
loadGymMenus();
