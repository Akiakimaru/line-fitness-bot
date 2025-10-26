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
    
    console.log('Food DB response data:', response.data);
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
  document.getElementById('stat-total').textContent = stats.total || 0;
  document.getElementById('stat-protein').textContent = stats.original || 0;
  document.getElementById('stat-carb').textContent = stats.learned || 0;
  document.getElementById('stat-confidence').textContent = stats.queueSize || 0;
}

/**
 * 食品一覧を表示
 */
function displayFoods(foodData, searchTerm) {
  const foodListDiv = document.getElementById('food-list');
  
  if (Object.keys(foodData).length === 0) {
    const message = searchTerm ? `「${searchTerm}」に一致する食品が見つかりませんでした。` : '食品データがありません。';
    foodListDiv.innerHTML = `
      <div class="glass-effect rounded-2xl p-12 text-center shadow-xl border border-white/20">
        <p class="text-7xl mb-6">🍎</p>
        <h2 class="text-2xl font-bold text-gray-800 mb-4">${message}</h2>
      </div>
    `;
    return;
  }
  
  let html = '';
  
  // 検索結果のヘッダー
  if (searchTerm) {
    html += `
      <div class="glass-effect rounded-xl p-4 mb-4 shadow-lg border border-white/20">
        <h3 class="text-lg font-semibold text-gray-800">🔍 検索結果: 「${searchTerm}」 (${Object.keys(foodData).length}件)</h3>
      </div>
    `;
  } else {
    html += `
      <div class="glass-effect rounded-xl p-4 mb-4 shadow-lg border border-white/20">
        <h3 class="text-lg font-semibold text-gray-800">📋 食品一覧 (最新50件)</h3>
      </div>
    `;
  }
  
  // 食品データを表示
  for (const [foodName, data] of Object.entries(foodData)) {
    html += `
      <div class="glass-effect rounded-xl p-5 shadow-lg border border-white/20 hover-lift">
        <div class="font-bold text-gray-800 mb-3 text-lg">${foodName}</div>
        <div class="grid grid-cols-4 gap-3">
          <div class="bg-gradient-to-br from-blue-50 to-indigo-50 rounded-lg p-3 text-center border border-blue-100">
            <div class="text-xs font-semibold text-blue-700 mb-1">タンパク質</div>
            <div class="text-lg font-bold text-blue-900">${data.protein}g</div>
          </div>
          <div class="bg-gradient-to-br from-amber-50 to-orange-50 rounded-lg p-3 text-center border border-amber-100">
            <div class="text-xs font-semibold text-amber-700 mb-1">脂質</div>
            <div class="text-lg font-bold text-amber-900">${data.fat}g</div>
          </div>
          <div class="bg-gradient-to-br from-green-50 to-emerald-50 rounded-lg p-3 text-center border border-green-100">
            <div class="text-xs font-semibold text-green-700 mb-1">炭水化物</div>
            <div class="text-lg font-bold text-green-900">${data.carbs}g</div>
          </div>
          <div class="bg-gradient-to-br from-purple-50 to-pink-50 rounded-lg p-3 text-center border border-purple-100">
            <div class="text-xs font-semibold text-purple-700 mb-1">カロリー</div>
            <div class="text-lg font-bold text-purple-900">${data.calories}</div>
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
