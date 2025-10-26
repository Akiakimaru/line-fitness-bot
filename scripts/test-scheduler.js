#!/usr/bin/env node
/**
 * スケジューラー機能のテストスクリプト
 * 実際のプッシュ通知は送信せず、ロジックのみテスト
 */

require('dotenv').config();
const { readUsersDetailed } = require('../lib/sheets');
const { getActiveShoppingPlan, getDailyMenu } = require('../lib/sheets');
const { generateDailyMenuWithRecipe, formatDailyMenuForLine } = require('../lib/llm');

async function testMealPrepLogic() {
  console.log('='.repeat(60));
  console.log('🧪 食事プッシュロジックのテスト');
  console.log('='.repeat(60));
  console.log();

  try {
    const slot = 'breakfast';
    const mealTime = '8:00';
    const today = new Date().toISOString().split('T')[0];

    console.log(`📅 テスト日時: ${today}`);
    console.log(`🍽  スロット: ${slot} (${mealTime})`);
    console.log();

    // ユーザー一覧を取得
    console.log('👥 Step 1: ユーザー一覧を取得');
    console.log('-'.repeat(60));
    const users = await readUsersDetailed();
    console.log(`✅ ${users.length}人のユーザーを取得しました`);
    console.log();

    // 各ユーザーについて処理をシミュレート
    for (const user of users.slice(0, 2)) { // 最初の2人のみテスト
      console.log(`🔍 ユーザー処理: ${user.UserId}`);
      console.log('-'.repeat(60));

      // 既存のメニューをチェック
      console.log(`  📖 既存の日次メニューを確認...`);
      let menu = await getDailyMenu(today, slot);
      
      if (menu) {
        console.log(`  ✅ 既存メニューが見つかりました: ${menu.menuName}`);
      } else {
        console.log(`  ⚠️  既存メニューなし。生成を試みます...`);
        
        // 買い出し計画を取得
        console.log(`  📋 買い出し計画を取得...`);
        const shoppingPlan = await getActiveShoppingPlan(user.UserId);
        
        if (shoppingPlan) {
          console.log(`  ✅ 買い出し計画が見つかりました (Week ${shoppingPlan.week})`);
          console.log(`  🤖 GPTで日次メニューを生成中...`);
          
          try {
            const generatedMenu = await generateDailyMenuWithRecipe(
              user.UserId,
              today,
              slot,
              shoppingPlan.planJson
            );
            
            console.log(`  ✅ メニュー生成成功: ${generatedMenu.menuName}`);
            console.log(`  📝 調理時間: ${generatedMenu.cookingTime}`);
            
            // LINEメッセージをフォーマット
            const lineMessage = formatDailyMenuForLine(generatedMenu, mealTime);
            console.log(`  📱 LINEメッセージ長: ${lineMessage.length}文字`);
            console.log();
            console.log('  --- LINEメッセージプレビュー ---');
            console.log(lineMessage.substring(0, 200) + '...');
            console.log('  --- ここまで ---');
            console.log();
            
          } catch (error) {
            console.error(`  ❌ メニュー生成エラー: ${error.message}`);
          }
          
        } else {
          console.log(`  ⚠️  買い出し計画なし。MealPlanにフォールバック`);
        }
      }
      
      console.log();
    }

    console.log('='.repeat(60));
    console.log('✅ テスト完了');
    console.log('='.repeat(60));

  } catch (error) {
    console.error('❌ テスト中にエラーが発生しました:');
    console.error(error);
    process.exit(1);
  }
}

async function testWeeklyShoppingPlanGeneration() {
  console.log('='.repeat(60));
  console.log('🧪 週次買い出し計画生成ロジックのテスト');
  console.log('='.repeat(60));
  console.log();

  try {
    console.log('👥 Step 1: ユーザー一覧を取得');
    console.log('-'.repeat(60));
    const users = await readUsersDetailed();
    console.log(`✅ ${users.length}人のユーザーを取得しました`);
    console.log();

    for (const user of users.slice(0, 1)) { // 最初の1人のみテスト
      console.log(`🔍 ユーザー処理: ${user.UserId}`);
      console.log('-'.repeat(60));

      const { generateShoppingPlan } = require('../lib/llm');
      const { saveShoppingPlan } = require('../lib/sheets');

      console.log('  🤖 GPTで買い出し計画を生成中...');
      const plan = await generateShoppingPlan(user.UserId, '');

      console.log('  ✅ 買い出し計画生成成功');
      console.log('  📊 計画内容:');
      console.log(`    - 目標: ${plan.plan_meta?.goal}`);
      console.log(`    - ジム時間帯: ${plan.plan_meta?.gym_time}`);
      console.log(`    - 買い出し頻度: 週${plan.plan_meta?.shopping_frequency}回`);
      
      // 有効期間を計算
      const now = new Date();
      const nextTuesday = new Date(now);
      nextTuesday.setDate(now.getDate() + ((2 - now.getDay() + 7) % 7 || 7));
      const validFrom = nextTuesday.toISOString().split('T')[0];
      
      const nextMonday = new Date(nextTuesday);
      nextMonday.setDate(nextTuesday.getDate() + 6);
      const validUntil = nextMonday.toISOString().split('T')[0];

      console.log(`  📅 有効期間: ${validFrom} 〜 ${validUntil}`);
      console.log();

      // 実際には保存しない（テストモード）
      console.log('  ℹ️  テストモードのため、保存はスキップします');
      console.log();
    }

    console.log('='.repeat(60));
    console.log('✅ テスト完了');
    console.log('='.repeat(60));

  } catch (error) {
    console.error('❌ テスト中にエラーが発生しました:');
    console.error(error);
    process.exit(1);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const testType = args[0] || 'meal';

  if (testType === 'meal') {
    await testMealPrepLogic();
  } else if (testType === 'weekly') {
    await testWeeklyShoppingPlanGeneration();
  } else {
    console.log('使い方:');
    console.log('  node scripts/test-scheduler.js meal    # 食事プッシュロジックをテスト');
    console.log('  node scripts/test-scheduler.js weekly  # 週次買い出し計画生成をテスト');
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}

module.exports = { testMealPrepLogic, testWeeklyShoppingPlanGeneration };

