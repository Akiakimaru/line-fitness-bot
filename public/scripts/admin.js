// 管理画面専用JavaScript - LINE Fitness Bot

// URLパラメータを取得
const params = getUrlParams();
const { key } = params;

/**
 * 管理画面の初期化
 */
function initializeAdmin() {
  // 最終更新時刻を設定
  const lastUpdated = document.getElementById('last-updated');
  if (lastUpdated) {
    lastUpdated.textContent = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
  }
  
  // 管理者キーが設定されていない場合は警告
  if (!key) {
    alert('管理者キーが設定されていません。URLに?key=your_admin_keyを追加してください。');
    return;
  }
  
  // すべてのボタンに管理者キーを設定
  setupAdminButtons();
}

/**
 * 管理画面のボタンを設定
 */
function setupAdminButtons() {
  const buttons = [
    { id: 'dashboard-btn', url: '/admin/dashboard' },
    { id: 'stats-btn', url: '/admin/stats' },
    { id: 'users-btn', url: '/admin/users' },
    { id: 'logs-btn', url: '/admin/logs' },
    { id: 'analyze-historical-btn', url: '/admin/analyze-historical' },
    { id: 'pfc-stats-btn', url: '/admin/pfc-stats' },
    { id: 'test-pfc-btn', url: '/admin/test-pfc' },
    { id: 'db-stats-btn', url: '/admin/db-stats' },
    { id: 'today-btn', url: '/admin/today' },
    { id: 'nextweek-validate-btn', url: '/admin/nextweek-validate' },
    { id: 'push-slot-btn', url: '/admin/push-slot' },
    { id: 'auto-gen-btn', url: '/admin/auto-gen' },
    { id: 'update-headers-btn', url: '/admin/update-headers' }
  ];
  
  buttons.forEach(button => {
    const element = document.getElementById(button.id);
    if (element) {
      element.href = `${button.url}?key=${encodeURIComponent(key)}`;
    }
  });
}

// 初期化実行
initializeAdmin();
