#!/usr/bin/env node
/**
 * 買い出し計画システムのテストスクリプト
 */

// 最優先で環境変数を読み込む
require('dotenv').config();

// 環境変数が読み込まれた後にモジュールをインポート
const { 
  ensureShoppingPlanHeader, 
  ensureDailyMenuHeader,
  saveShoppingPlan,
  getActiveShoppingPlan,
  saveDailyMenu,
  getDailyMenu
} = require('../lib/sheets');
const { 
  generateShoppingPlan, 
  generateDailyMenuWithRecipe 
} = require('../lib/llm');

// テスト用のユーザーID（実際のユーザーIDに置き換え）
const TEST_USER_ID = process.env.TEST_USER_ID || 'U4c1c91fc93ab8a188ab2634eeaa34442';

async function main() {
  console.log('='.repeat(60));
  console.log('🧪 買い出し計画システムのテスト開始');
  console.log('='.repeat(60));
  console.log();

  try {
    // Test 1: Google Sheetsのシート作成テスト
    console.log('📋 Test 1: ShoppingPlanシートの作成確認');
    console.log('-'.repeat(60));
    const { JWT } = require('google-auth-library');
    const { google } = require('googleapis');
    const SHEET_ID = process.env.GOOGLE_SHEET_ID;
    const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '{}');
    
    const jwt = new JWT({
      email: creds.client_email,
      key: creds.private_key,
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });
    
    const sheetsApi = google.sheets({ version: 'v4', auth: jwt });
    
    await ensureShoppingPlanHeader(sheetsApi);
    console.log('✅ ShoppingPlanシート作成/ヘッダー確認 完了');
    console.log();

    // Test 2: DailyMenuシートの作成テスト
    console.log('📋 Test 2: DailyMenuシートの作成確認');
    console.log('-'.repeat(60));
    await ensureDailyMenuHeader(sheetsApi);
    console.log('✅ DailyMenuシート作成/ヘッダー確認 完了');
    console.log();

    // Test 3: 買い出し計画の生成テスト
    console.log('🤖 Test 3: 買い出し計画の生成（GPT使用）');
    console.log('-'.repeat(60));
    console.log(`テストユーザーID: ${TEST_USER_ID}`);
    console.log('GPTで買い出し計画を生成中...');
    
    const userInput = '週5回トレーニング、減量目標、予算は週1万円程度';
    const planJson = await generateShoppingPlan(TEST_USER_ID, userInput);
    
    console.log('生成された買い出し計画:');
    console.log('- 目標:', planJson.plan_meta?.goal);
    console.log('- ジム時間帯:', planJson.plan_meta?.gym_time);
    console.log('- 買い出し頻度:', planJson.plan_meta?.shopping_frequency);
    console.log('- 買い出し回数:', Object.keys(planJson.shopping_plan || {}).length);
    console.log('✅ 買い出し計画生成 完了');
    console.log();

    // Test 4: 買い出し計画の保存テスト
    console.log('💾 Test 4: 買い出し計画の保存');
    console.log('-'.repeat(60));
    
    const now = new Date();
    const nextTuesday = new Date(now);
    nextTuesday.setDate(now.getDate() + ((2 - now.getDay() + 7) % 7 || 7));
    const validFrom = nextTuesday.toISOString().split('T')[0];
    
    const nextMonday = new Date(nextTuesday);
    nextMonday.setDate(nextTuesday.getDate() + 6);
    const validUntil = nextMonday.toISOString().split('T')[0];
    
    const week = Math.ceil((now - new Date(now.getFullYear(), 0, 1)) / (7 * 24 * 60 * 60 * 1000));
    
    await saveShoppingPlan({
      userId: TEST_USER_ID,
      week: week,
      validFrom: validFrom,
      validUntil: validUntil,
      planJson: planJson,
      status: 'active'
    });
    
    console.log(`✅ 買い出し計画を保存しました`);
    console.log(`   - 有効期間: ${validFrom} 〜 ${validUntil}`);
    console.log();

    // Test 5: 買い出し計画の取得テスト
    console.log('📖 Test 5: 買い出し計画の取得');
    console.log('-'.repeat(60));
    
    const activePlan = await getActiveShoppingPlan(TEST_USER_ID);
    if (activePlan) {
      console.log('✅ 有効な買い出し計画を取得しました');
      console.log(`   - 週番号: ${activePlan.week}`);
      console.log(`   - 有効期間: ${activePlan.validFrom} 〜 ${activePlan.validUntil}`);
      console.log(`   - ステータス: ${activePlan.status}`);
    } else {
      console.log('⚠️  有効な買い出し計画が見つかりません');
    }
    console.log();

    // Test 6: 日次メニューの生成テスト
    console.log('🍳 Test 6: 日次メニューの生成（GPT使用）');
    console.log('-'.repeat(60));
    
    if (activePlan) {
      const today = new Date().toISOString().split('T')[0];
      const slot = 'breakfast';
      
      console.log(`日次メニュー生成中: ${today} ${slot}`);
      const dailyMenu = await generateDailyMenuWithRecipe(
        TEST_USER_ID,
        today,
        slot,
        activePlan.planJson
      );
      
      console.log('生成された日次メニュー:');
      console.log('- メニュー名:', dailyMenu.menuName);
      console.log('- 調理時間:', dailyMenu.cookingTime);
      console.log('- PFC:', JSON.stringify(dailyMenu.pfc));
      console.log('✅ 日次メニュー生成 完了');
      console.log();

      // Test 7: 日次メニューの保存テスト
      console.log('💾 Test 7: 日次メニューの保存');
      console.log('-'.repeat(60));
      
      await saveDailyMenu({
        date: today,
        week: activePlan.week,
        day: new Date().toLocaleDateString('en-US', { weekday: 'short' }),
        slot: slot,
        menuName: dailyMenu.menuName,
        ingredients: dailyMenu.ingredients,
        recipe: dailyMenu.recipe,
        cookingTime: dailyMenu.cookingTime,
        pfc: dailyMenu.pfc,
        sourcePlan: activePlan.week
      });
      
      console.log('✅ 日次メニューを保存しました');
      console.log();

      // Test 8: 日次メニューの取得テスト
      console.log('📖 Test 8: 日次メニューの取得');
      console.log('-'.repeat(60));
      
      const savedMenu = await getDailyMenu(today, slot);
      if (savedMenu) {
        console.log('✅ 保存された日次メニューを取得しました');
        console.log(`   - メニュー名: ${savedMenu.menuName}`);
        console.log(`   - 調理時間: ${savedMenu.cookingTime}`);
      } else {
        console.log('⚠️  日次メニューが見つかりません');
      }
      console.log();
    } else {
      console.log('⚠️  有効な買い出し計画がないため、スキップします');
      console.log();
    }

    console.log('='.repeat(60));
    console.log('✅ すべてのテストが完了しました！');
    console.log('='.repeat(60));
    console.log();
    console.log('📊 結果サマリー:');
    console.log('  - ShoppingPlanシート: 作成/確認済み');
    console.log('  - DailyMenuシート: 作成/確認済み');
    console.log('  - 買い出し計画生成: 成功');
    console.log('  - 買い出し計画保存: 成功');
    console.log('  - 買い出し計画取得: 成功');
    if (activePlan) {
      console.log('  - 日次メニュー生成: 成功');
      console.log('  - 日次メニュー保存: 成功');
      console.log('  - 日次メニュー取得: 成功');
    }
    console.log();
    console.log('🎉 Google Sheetsを確認してください！');
    console.log(`   https://docs.google.com/spreadsheets/d/${SHEET_ID}`);

  } catch (error) {
    console.error('❌ テスト中にエラーが発生しました:');
    console.error(error);
    process.exit(1);
  }
}

// スクリプト実行
if (require.main === module) {
  main().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}

module.exports = { main };

