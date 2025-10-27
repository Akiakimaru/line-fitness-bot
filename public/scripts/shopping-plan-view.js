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
    
    // APIから買い出し計画を取得（過去4週間分）
    const response = await apiCall(`/user/shopping-plan?uid=${encodeURIComponent(uid)}&exp=${encodeURIComponent(exp)}&sig=${encodeURIComponent(sig)}&weeks=4`);
    
    if (!response.ok) {
      throw new Error(response.error || '買い出し計画の取得に失敗しました');
    }
    
    const { plans, count } = response.data;
    
    if (!plans || plans.length === 0) {
      displayNoPlan();
      return;
    }
    
    displayPlans(plans);
    updateStatus('status-message', `${count}件の買い出し計画を読み込みました`, 'good');
    
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
 * 複数の買い出し計画を表示（アコーディオン形式）
 */
function displayPlans(plans) {
  const content = document.getElementById('plan-content');
  let html = '';
  
  plans.forEach((plan, index) => {
    const isFirst = index === 0;
    const isCurrent = plan.isCurrent;
    const accordionId = `accordion-${index}`;
    
    // 期間の日付をフォーマット
    const validFrom = new Date(plan.validFrom);
    const validUntil = new Date(plan.validUntil);
    const fromStr = `${validFrom.getMonth() + 1}/${validFrom.getDate()}`;
    const untilStr = `${validUntil.getMonth() + 1}/${validUntil.getDate()}`;
    
    // 現在の計画かどうかでスタイルを変更
    const borderColor = isCurrent ? 'border-green-300' : 'border-purple-200';
    const headerBg = isCurrent ? 'bg-gradient-to-r from-green-500 to-emerald-600' : 'bg-gradient-to-r from-purple-500 to-pink-600';
    const badge = isCurrent ? '<span class="ml-3 px-3 py-1 bg-white/30 text-white text-xs rounded-full font-semibold">📍 今週</span>' : '';
    
    html += `
      <div class="glass-effect rounded-2xl shadow-xl border ${borderColor} mb-4 animate-fade-in-up" style="animation-delay: ${index * 0.1}s;">
        <!-- アコーディオンヘッダー -->
        <button 
          onclick="toggleAccordion('${accordionId}')" 
          class="${headerBg} text-white py-5 px-6 rounded-t-2xl w-full text-left flex items-center justify-between hover:opacity-90 transition-opacity"
        >
          <div class="flex items-center gap-3">
            <span class="text-3xl">📋</span>
            <div>
              <h3 class="text-xl font-bold">Week ${plan.week}</h3>
              <p class="text-white/90 text-sm mt-1">${fromStr} 〜 ${untilStr}</p>
            </div>
            ${badge}
          </div>
          <svg id="${accordionId}-icon" class="w-6 h-6 transition-transform ${isFirst ? 'rotate-180' : ''}" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"></path>
          </svg>
        </button>
        
        <!-- アコーディオンコンテンツ -->
        <div id="${accordionId}" class="overflow-hidden transition-all duration-300" style="${isFirst ? '' : 'max-height: 0;'}">
          <div class="p-6">
            ${generatePlanContent(plan)}
          </div>
        </div>
      </div>
    `;
  });
  
  content.innerHTML = html;
  
  // 最初のアコーディオンを開く
  if (plans.length > 0) {
    setTimeout(() => {
      const firstAccordion = document.getElementById('accordion-0');
      if (firstAccordion) {
        firstAccordion.style.maxHeight = firstAccordion.scrollHeight + 'px';
      }
    }, 100);
  }
}

/**
 * アコーディオンの開閉
 */
function toggleAccordion(accordionId) {
  const content = document.getElementById(accordionId);
  const icon = document.getElementById(`${accordionId}-icon`);
  
  if (content.style.maxHeight && content.style.maxHeight !== '0px') {
    // 閉じる
    content.style.maxHeight = '0px';
    icon.classList.remove('rotate-180');
  } else {
    // 開く
    content.style.maxHeight = content.scrollHeight + 'px';
    icon.classList.add('rotate-180');
  }
}

// グローバルに公開
window.toggleAccordion = toggleAccordion;

/**
 * 計画の詳細コンテンツを生成
 */
function generatePlanContent(plan) {
  const planJson = plan.planJson;
  const meta = planJson.plan_meta || {};
  const shopping = planJson.shopping_plan || {};
  const batchCook = planJson.batch_cook || [];
  const notes = planJson.notes || [];
  
  let html = '';
  
  // メタ情報
  html += `
    <div class="bg-gradient-to-br from-gray-50 to-white rounded-xl p-5 border border-gray-200 shadow-sm mb-4">
      <h4 class="text-lg font-bold text-gray-800 mb-3 flex items-center gap-2">
        <span>📊</span>
        <span>計画概要</span>
      </h4>
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div class="bg-gradient-to-br from-purple-50 to-pink-50 rounded-lg p-3 border border-purple-100">
          <div class="text-xs text-gray-600 mb-1">🎯 目標</div>
          <div class="font-semibold text-gray-800 text-sm">${meta.goal === 'cut' ? '減量（筋量維持）' : meta.goal}</div>
        </div>
        <div class="bg-gradient-to-br from-green-50 to-emerald-50 rounded-lg p-3 border border-green-100">
          <div class="text-xs text-gray-600 mb-1">💪 トレーニング</div>
          <div class="font-semibold text-gray-800 text-sm">週${meta.gym_frequency || 5}回</div>
        </div>
        ${meta.pfc_target ? `
        <div class="bg-gradient-to-br from-orange-50 to-amber-50 rounded-lg p-3 border border-orange-100 sm:col-span-2">
          <div class="text-xs text-gray-600 mb-1">📊 PFC目標</div>
          <div class="font-semibold text-gray-800 text-sm">P${meta.pfc_target.protein_g}g・F${meta.pfc_target.fat_g}g・C${meta.pfc_target.carb_g}g・${meta.pfc_target.kcal}kcal</div>
        </div>
        ` : ''}
      </div>
    </div>
  `;
  
  // 買い出し1回目
  if (shopping.trip_1) {
    html += generateTripContent(shopping.trip_1);
  }
  
  // 買い出し2回目
  if (shopping.trip_2) {
    html += generateTripContent(shopping.trip_2);
  }
  
  // 作り置き
  if (batchCook.length > 0) {
    html += `
      <div class="bg-gradient-to-br from-amber-50 to-orange-50 rounded-xl p-5 border border-amber-200 shadow-sm mb-4">
        <h4 class="text-lg font-bold text-amber-900 mb-3 flex items-center gap-2">
          <span>🍳</span>
          <span>作り置き予定</span>
        </h4>
    `;
    
    batchCook.forEach(batch => {
      html += `<h5 class="font-semibold text-amber-800 mb-2 mt-3 text-sm">${batch.when}</h5>`;
      (batch.recipes || []).forEach(recipe => {
        html += `
          <div class="bg-white rounded-lg p-3 mb-2 shadow-sm border border-amber-100">
            <div class="font-semibold text-gray-800 text-sm mb-1">${recipe.title}</div>
            <div class="text-xs text-gray-600">${recipe.servings}人分・保存: ${recipe.store?.method || '冷蔵'}${recipe.store?.days || 3}日</div>
          </div>
        `;
      });
    });
    
    html += `</div>`;
  }
  
  // ポイント
  if (notes.length > 0) {
    html += `
      <div class="bg-gradient-to-br from-cyan-50 to-blue-50 rounded-xl p-5 border border-cyan-200 shadow-sm mb-4">
        <h4 class="text-lg font-bold text-cyan-900 mb-3 flex items-center gap-2">
          <span>💡</span>
          <span>ポイント</span>
        </h4>
        <ul class="space-y-2">
    `;
    
    notes.forEach(note => {
      html += `
        <li class="flex items-start gap-2 text-gray-700 text-sm">
          <span class="text-cyan-500 text-base flex-shrink-0">•</span>
          <span>${note}</span>
        </li>
      `;
    });
    
    html += `
        </ul>
      </div>
    `;
  }
  
  return html;
}

/**
 * 買い出し詳細を生成
 */
function generateTripContent(trip) {
  let html = `
    <div class="bg-gradient-to-br from-blue-50 to-indigo-50 rounded-xl p-5 border border-blue-200 shadow-sm mb-4">
      <h4 class="text-lg font-bold text-gray-800 mb-3 flex items-center gap-2">
        <span>🛒</span>
        <span>${trip.when}</span>
      </h4>
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
      <div class="mb-4 last:mb-0">
        <h5 class="font-semibold text-gray-700 mb-2 pb-1 border-b border-gray-300 text-sm">${category}</h5>
        <ul class="space-y-1">
    `;
    
    items.forEach(item => {
      html += `
        <li class="flex items-center justify-between py-2 px-2 rounded-lg hover:bg-white/70 transition-colors">
          <span class="font-medium text-gray-800 text-sm">${item.name}</span>
          <span class="text-xs text-gray-600 bg-white/80 px-2 py-1 rounded-full">${item.quantity}</span>
        </li>
      `;
    });
    
    html += `
        </ul>
      </div>
    `;
  });
  
  html += `
      <div class="mt-3 pt-3 border-t border-blue-200 flex items-center justify-between">
        <span class="text-xs text-gray-600">合計</span>
        <span class="font-semibold text-gray-800 text-sm">${trip.items?.length || 0} 品</span>
      </div>
    </div>
  `;
  
  return html;
}

// 初期化
setupBackButton();
loadShoppingPlan();

