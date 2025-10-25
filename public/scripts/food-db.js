// 食品データベース専用JavaScript - LINE Fitness Bot

// URLパラメータを取得
const params = getUrlParams();
const { uid, exp, sig } = params;

console.log('FoodDB params:', { uid, exp, sig });

/**
 * マイページに戻る
 */
function goBack() {
  if (!uid || !exp || !sig) {
    alert('URLパラメータが不足しています。');
    return;
  }
  const url = `/mypage?uid=${encodeURIComponent(uid)}&exp=${encodeURIComponent(exp)}&sig=${encodeURIComponent(sig)}`;
  window.location.href = url;
}

/**
 * 食品を検索
 */
function searchFoods() {
  const searchTerm = document.getElementById('search-input').value.trim();
  if (!searchTerm) {
    alert('検索語を入力してください。');
    return;
  }
  loadFoodData(searchTerm);
}

/**
 * 全食品を表示
 */
function loadAllFoods() {
  document.getElementById('search-input').value = '';
  loadFoodData();
}

/**
 * 食品データを読み込み
 */
async function loadFoodData(searchTerm = null) {
  try {
    updateStatus('food-list', 'データ読み込み中...', 'info');
    
    if (!uid || !exp || !sig) {
      throw new Error('URLパラメータが不足しています');
    }
    
    const url = `/user/food-db?uid=${encodeURIComponent(uid)}&exp=${encodeURIComponent(exp)}&sig=${encodeURIComponent(sig)}${searchTerm ? '&search=' + encodeURIComponent(searchTerm) : ''}`;
    console.log('Loading food data from:', url);
    
    const response = await apiCall(url);
    console.log('Food DB response:', response);
    
    if (!response.ok) {
      throw new Error(response.error || 'データの取得に失敗しました');
    }
    
    displayStats(response.data.stats);
    displayFoods(response.data.foodData, response.data.search);
    
  } catch (error) {
    handleError(error, 'loadFoodData');
    updateStatus('food-list', 'データの読み込みに失敗しました: ' + error.message, 'warning');
  }
}

/**
 * 統計情報を表示
 */
function displayStats(stats) {
  document.getElementById('total-foods').textContent = stats.total;
  document.getElementById('original-foods').textContent = stats.original;
  document.getElementById('learned-foods').textContent = stats.learned;
  document.getElementById('queue-size').textContent = stats.queueSize;
  document.getElementById('stats-section').style.display = 'grid';
}

/**
 * 食品一覧を表示
 */
function displayFoods(foodData, searchTerm) {
  const foodListDiv = document.getElementById('food-list');
  
  if (Object.keys(foodData).length === 0) {
    const message = searchTerm ? `「${searchTerm}」に一致する食品が見つかりませんでした。` : '食品データがありません。';
    foodListDiv.innerHTML = `<div class="no-results">${message}</div>`;
    return;
  }
  
  let html = '';
  
  // 検索結果のヘッダー
  if (searchTerm) {
    html += `<h3>🔍 検索結果: 「${searchTerm}」 (${Object.keys(foodData).length}件)</h3>`;
  } else {
    html += `<h3>📋 食品一覧 (最新50件)</h3>`;
  }
  
  // 食品データを表示
  for (const [foodName, data] of Object.entries(foodData)) {
    html += `
      <div class="food-item">
        <div class="food-name">${foodName}</div>
        <div class="pfc-info">
          <div class="pfc-item">
            <div class="pfc-label">P</div>
            <div class="pfc-value">${data.protein}g</div>
          </div>
          <div class="pfc-item">
            <div class="pfc-label">F</div>
            <div class="pfc-value">${data.fat}g</div>
          </div>
          <div class="pfc-item">
            <div class="pfc-label">C</div>
            <div class="pfc-value">${data.carbs}g</div>
          </div>
          <div class="pfc-item">
            <div class="pfc-label">kcal</div>
            <div class="pfc-value">${data.calories}</div>
          </div>
        </div>
      </div>
    `;
  }
  
  foodListDiv.innerHTML = html;
}

/**
 * 検索入力でEnterキー対応
 */
document.addEventListener('DOMContentLoaded', function() {
  const searchInput = document.getElementById('search-input');
  if (searchInput) {
    searchInput.addEventListener('keypress', function(e) {
      if (e.key === 'Enter') {
        searchFoods();
      }
    });
  }
  
  // 初期データ読み込み
  loadFoodData();
});
