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
      container.innerHTML = `
        <div class="col-span-full glass-effect rounded-2xl p-12 text-center shadow-xl border border-white/20 animate-fade-in-up">
          <p class="text-7xl mb-6">💪</p>
          <h2 class="text-2xl font-bold text-gray-800 mb-4">まだジム記録がありません</h2>
          <p class="text-gray-600 leading-relaxed">LINE Botでトレーニングを記録しましょう！</p>
        </div>
      `;
    } else {
      updateStatus('status-message', 'データ読み込み完了', 'info');
      
      // 日付順にソート（新しい順）
      const sortedLogs = gymLogs.sort((a, b) => new Date(b.DateTime) - new Date(a.DateTime));
      
      sortedLogs.forEach(log => {
        const menuCard = document.createElement('div');
        menuCard.className = 'glass-effect rounded-2xl p-6 shadow-lg border border-white/20 hover-lift animate-fade-in-up';
        
        const date = document.createElement('div');
        date.className = 'text-sm font-semibold text-indigo-600 mb-3 flex items-center gap-2';
        date.innerHTML = `<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"></path></svg><span>${formatJST(log.DateTime)}</span>`;
        menuCard.appendChild(date);
        
        const content = document.createElement('div');
        content.className = 'text-gray-700 whitespace-pre-line leading-relaxed';
        
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
              menuText += '\n';
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
