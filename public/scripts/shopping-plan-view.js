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
    <div class="no-plan">
      <p style="font-size: 3rem; margin-bottom: 1rem;">📋</p>
      <h2>買い出し計画がありません</h2>
      <p style="margin-top: 1rem;">LINE Botで「買い出し計画」と送信するか、<br>毎週月曜21時に自動生成されます。</p>
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
    <div class="plan-meta">
      <div class="plan-meta-item">
        <span><strong>📅 有効期間</strong></span>
        <span>${plan.validFrom} 〜 ${plan.validUntil}</span>
      </div>
      <div class="plan-meta-item">
        <span><strong>🎯 目標</strong></span>
        <span>${meta.goal === 'cut' ? '減量（筋量維持）' : meta.goal}</span>
      </div>
      <div class="plan-meta-item">
        <span><strong>💪 トレーニング</strong></span>
        <span>週${meta.gym_frequency || 5}回</span>
      </div>
      ${meta.pfc_target ? `
      <div class="plan-meta-item">
        <span><strong>📊 PFC目標</strong></span>
        <span>P${meta.pfc_target.protein_g}g・F${meta.pfc_target.fat_g}g・C${meta.pfc_target.carb_g}g・${meta.pfc_target.kcal}kcal</span>
      </div>
      ` : ''}
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
    html += `<div class="batch-cook-section">`;
    html += `<div class="batch-title">🍳 作り置き予定</div>`;
    
    batchCook.forEach(batch => {
      html += `<h3>${batch.when}</h3>`;
      (batch.recipes || []).forEach(recipe => {
        html += `
          <div class="recipe-card">
            <div class="recipe-name">${recipe.title}</div>
            <div class="recipe-info">${recipe.servings}人分・保存: ${recipe.store?.method || '冷蔵'}${recipe.store?.days || 3}日</div>
          </div>
        `;
      });
    });
    
    html += `</div>`;
  }
  
  // ポイント
  if (notes.length > 0) {
    html += `
      <div class="notes-section">
        <div class="notes-title">💡 ポイント</div>
        <ul class="notes-list">
    `;
    
    notes.forEach(note => {
      html += `<li>${note}</li>`;
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
    <div class="trip-section">
      <div class="trip-title">${trip.when}</div>
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
      <div class="category-group">
        <div class="category-title">${category}</div>
        <ul class="item-list">
    `;
    
    items.forEach(item => {
      html += `
        <li>
          <span class="item-name">${item.name}</span>
          <span class="item-quantity">${item.quantity}</span>
        </li>
      `;
    });
    
    html += `
        </ul>
      </div>
    `;
  });
  
  html += `
      <div style="margin-top: 1rem; padding-top: 1rem; border-top: 1px solid #dee2e6; color: #6c757d; font-size: 0.9rem;">
        合計 ${trip.items?.length || 0} 品
      </div>
    </div>
  `;
  
  return html;
}

// 初期化
setupBackButton();
loadShoppingPlan();

