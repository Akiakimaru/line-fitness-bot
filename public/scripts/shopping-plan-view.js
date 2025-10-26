// shopping-plan-view.js - 買い出し計画表示ページ

// URLパラメータを取得
const params = getUrlParams();
const { uid, exp, sig } = params;

console.log('Shopping Plan View params:', { uid, exp, sig });

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
 * 買い出し計画を表示
 */
async function loadShoppingPlan() {
  try {
    updateStatus('status-message', 'データ読み込み中...', 'info');
    
    if (!uid || !exp || !sig) {
      throw new Error('URLパラメータが不足しています');
    }
    
    // APIから買い出し計画を取得
    const response = await apiCall(`/user/shopping-plan?uid=${encodeURIComponent(uid)}&exp=${encodeURIComponent(exp)}&sig=${encodeURIComponent(sig)}`);
    
    if (!response.ok) {
      throw new Error(response.error || '買い出し計画の取得に失敗しました');
    }
    
    const { plan } = response.data;
    
    if (!plan) {
      displayNoPlan();
      return;
    }
    
    displayPlan(plan);
    updateStatus('status-message', 'データ読み込み完了', 'good');
    
  } catch (error) {
    handleError(error, 'loadShoppingPlan');
    updateStatus('status-message', 'データの読み込みに失敗しました: ' + error.message, 'warning');
  }
}

/**
 * 計画がない場合の表示
 */
function displayNoPlan() {
  const content = document.getElementById('plan-content');
  content.innerHTML = `
    <div class="glass-effect rounded-2xl p-12 text-center shadow-xl border border-white/20 animate-fade-in-up">
      <p class="text-7xl mb-6">📋</p>
      <h2 class="text-2xl font-bold text-gray-800 mb-4">買い出し計画がありません</h2>
      <p class="text-gray-600 leading-relaxed">
        LINE Botで「買い出し計画」と送信するか、<br>
        毎週月曜21時に自動生成されます。
      </p>
    </div>
  `;
}

/**
 * 買い出し計画を表示
 */
function displayPlan(plan) {
  const planJson = plan.planJson;
  const meta = planJson.plan_meta || {};
  const shopping = planJson.shopping_plan || {};
  const batchCook = planJson.batch_cook || [];
  const notes = planJson.notes || [];
  
  let html = '';
  
  // メタ情報
  html += `
    <div class="glass-effect rounded-2xl p-6 shadow-xl border border-white/20 mb-6 animate-fade-in-up">
      <h3 class="text-xl font-bold text-gray-800 mb-4 flex items-center gap-2">
        <span>📊</span>
        <span>計画概要</span>
      </h3>
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div class="bg-gradient-to-br from-blue-50 to-indigo-50 rounded-xl p-4 border border-blue-100">
          <div class="text-sm text-gray-600 mb-1">📅 有効期間</div>
          <div class="font-semibold text-gray-800">${plan.validFrom} 〜 ${plan.validUntil}</div>
        </div>
        <div class="bg-gradient-to-br from-purple-50 to-pink-50 rounded-xl p-4 border border-purple-100">
          <div class="text-sm text-gray-600 mb-1">🎯 目標</div>
          <div class="font-semibold text-gray-800">${meta.goal === 'cut' ? '減量（筋量維持）' : meta.goal}</div>
        </div>
        <div class="bg-gradient-to-br from-green-50 to-emerald-50 rounded-xl p-4 border border-green-100">
          <div class="text-sm text-gray-600 mb-1">💪 トレーニング</div>
          <div class="font-semibold text-gray-800">週${meta.gym_frequency || 5}回</div>
        </div>
        ${meta.pfc_target ? `
        <div class="bg-gradient-to-br from-orange-50 to-amber-50 rounded-xl p-4 border border-orange-100">
          <div class="text-sm text-gray-600 mb-1">📊 PFC目標</div>
          <div class="font-semibold text-gray-800 text-sm">P${meta.pfc_target.protein_g}g・F${meta.pfc_target.fat_g}g・C${meta.pfc_target.carb_g}g・${meta.pfc_target.kcal}kcal</div>
        </div>
        ` : ''}
      </div>
    </div>
  `;
  
  // 買い出し1回目
  if (shopping.trip_1) {
    html += displayTrip(shopping.trip_1);
  }
  
  // 買い出し2回目
  if (shopping.trip_2) {
    html += displayTrip(shopping.trip_2);
  }
  
  // 作り置き
  if (batchCook.length > 0) {
    html += `
      <div class="glass-effect rounded-2xl p-6 shadow-xl border border-amber-200 mb-6 animate-fade-in-up bg-gradient-to-br from-amber-50 to-orange-50" style="animation-delay: 0.2s;">
        <h3 class="text-xl font-bold text-amber-900 mb-4 flex items-center gap-2">
          <span>🍳</span>
          <span>作り置き予定</span>
        </h3>
    `;
    
    batchCook.forEach(batch => {
      html += `<h4 class="font-semibold text-amber-800 mb-3 mt-4">${batch.when}</h4>`;
      (batch.recipes || []).forEach(recipe => {
        html += `
          <div class="bg-white rounded-xl p-4 mb-3 shadow-sm border border-amber-100 hover-lift">
            <div class="font-semibold text-gray-800 mb-1">${recipe.title}</div>
            <div class="text-sm text-gray-600">${recipe.servings}人分・保存: ${recipe.store?.method || '冷蔵'}${recipe.store?.days || 3}日</div>
          </div>
        `;
      });
    });
    
    html += `</div>`;
  }
  
  // ポイント
  if (notes.length > 0) {
    html += `
      <div class="glass-effect rounded-2xl p-6 shadow-xl border border-cyan-200 mb-6 animate-fade-in-up bg-gradient-to-br from-cyan-50 to-blue-50" style="animation-delay: 0.3s;">
        <h3 class="text-xl font-bold text-cyan-900 mb-4 flex items-center gap-2">
          <span>💡</span>
          <span>ポイント</span>
        </h3>
        <ul class="space-y-2">
    `;
    
    notes.forEach(note => {
      html += `
        <li class="flex items-start gap-3 text-gray-700">
          <span class="text-cyan-500 text-xl flex-shrink-0">•</span>
          <span>${note}</span>
        </li>
      `;
    });
    
    html += `
        </ul>
      </div>
    `;
  }
  
  document.getElementById('plan-content').innerHTML = html;
}

/**
 * 買い出し詳細を表示
 */
function displayTrip(trip) {
  let html = `
    <div class="glass-effect rounded-2xl p-6 shadow-xl border border-white/20 mb-6 animate-fade-in-up" style="animation-delay: 0.1s;">
      <h3 class="text-xl font-bold text-gray-800 mb-4 flex items-center gap-2">
        <span>🛒</span>
        <span>${trip.when}</span>
      </h3>
  `;
  
  // カテゴリ別にグループ化
  const categories = {};
  (trip.items || []).forEach(item => {
    const cat = item.category || 'その他';
    if (!categories[cat]) categories[cat] = [];
    categories[cat].push(item);
  });
  
  // カテゴリごとに表示
  Object.entries(categories).forEach(([category, items]) => {
    html += `
      <div class="mb-6 last:mb-0">
        <h4 class="font-semibold text-gray-700 mb-3 pb-2 border-b-2 border-gray-200">${category}</h4>
        <ul class="space-y-2">
    `;
    
    items.forEach(item => {
      html += `
        <li class="flex items-center justify-between py-2 px-3 rounded-lg hover:bg-white/50 transition-colors">
          <span class="font-medium text-gray-800">${item.name}</span>
          <span class="text-sm text-gray-600 bg-gray-100 px-3 py-1 rounded-full">${item.quantity}</span>
        </li>
      `;
    });
    
    html += `
        </ul>
      </div>
    `;
  });
  
  html += `
      <div class="mt-6 pt-4 border-t border-gray-200 flex items-center justify-between">
        <span class="text-sm text-gray-600">合計</span>
        <span class="font-semibold text-gray-800">${trip.items?.length || 0} 品</span>
      </div>
    </div>
  `;
  
  return html;
}

// 初期化
setupBackButton();
loadShoppingPlan();

