// 共通JavaScript - LINE Fitness Bot

/**
 * API呼び出し用のヘルパー関数
 */
async function apiCall(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error('HTTP ' + response.status);
  }
  return response.json();
}

/**
 * ISO文字列をJST時刻に変換
 */
function formatJST(iso) {
  try {
    const date = new Date(iso);
    if (isNaN(date.getTime())) {
      return String(iso);
    }
    return date.toLocaleString('ja-JP', {
      timeZone: 'Asia/Tokyo',
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    });
  } catch (error) {
    return String(iso);
  }
}

/**
 * ステータスメッセージを更新
 */
function updateStatus(elementId, message, type = 'info') {
  const statusEl = document.getElementById(elementId);
  if (statusEl) {
    statusEl.textContent = message;
    statusEl.className = 'status-badge status-' + type;
  }
}

/**
 * URLパラメータを取得
 */
function getUrlParams() {
  const urlParams = new URLSearchParams(window.location.search);
  return {
    uid: urlParams.get('uid'),
    exp: urlParams.get('exp'),
    sig: urlParams.get('sig'),
    key: urlParams.get('key')
  };
}

/**
 * デバッグ情報を表示
 */
function showDebugInfo(message, details = {}) {
  console.error('Debug:', message, details);
  
  const debugInfo = document.createElement('div');
  debugInfo.style.cssText = 'background: #ffe6e6; padding: 12px; border-radius: 8px; margin: 12px 0; font-size: 12px; color: #d00;';
  
  let debugHTML = '<strong>🐛 デバッグ情報</strong><br>' + message;
  
  for (const [key, value] of Object.entries(details)) {
    debugHTML += '<br>' + key + ': ' + (value || 'undefined');
  }
  
  debugInfo.innerHTML = debugHTML;
  
  const container = document.querySelector('.container') || document.body;
  const statusMessage = document.getElementById('status-message');
  if (statusMessage) {
    container.insertBefore(debugInfo, statusMessage);
  } else {
    container.appendChild(debugInfo);
  }
}

/**
 * エラーハンドリング
 */
function handleError(error, context = '') {
  console.error('Error in ' + context + ':', error);
  showDebugInfo('エラーが発生しました: ' + error.message, {
    context: context,
    error: error.message
  });
}
