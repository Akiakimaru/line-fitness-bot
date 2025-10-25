#!/usr/bin/env node
/**
 * API更新チェックスクリプト
 * 
 * 使用方法:
 * node scripts/check-api-updates.js
 * 
 * 機能:
 * - パッケージの古いバージョン確認
 * - セキュリティ脆弱性チェック
 * - 更新可能なパッケージ一覧表示
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// カラー出力用の定数
const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
};

function log(message, color = colors.reset) {
  console.log(`${color}${message}${colors.reset}`);
}

function execCommand(command) {
  try {
    return execSync(command, { encoding: 'utf8', stdio: 'pipe' });
  } catch (error) {
    return error.stdout || error.message;
  }
}

function checkOutdatedPackages() {
  log('\n📦 パッケージバージョン確認中...', colors.blue);
  
  const output = execCommand('npm outdated');
  
  if (output.trim() === '') {
    log('✅ すべてのパッケージが最新バージョンです', colors.green);
    return [];
  }
  
  log('⚠️  更新可能なパッケージがあります:', colors.yellow);
  console.log(output);
  
  // パッケージ名を抽出
  const lines = output.split('\n').filter(line => line.trim() && !line.includes('Package'));
  const outdatedPackages = lines.map(line => {
    const parts = line.split(/\s+/);
    return {
      name: parts[0],
      current: parts[1],
      wanted: parts[2],
      latest: parts[3]
    };
  });
  
  return outdatedPackages;
}

function checkSecurityVulnerabilities() {
  log('\n🔒 セキュリティ脆弱性チェック中...', colors.blue);
  
  const auditOutput = execCommand('npm audit --json');
  let auditData;
  
  try {
    auditData = JSON.parse(auditOutput);
  } catch (error) {
    log('❌ npm auditの結果を解析できませんでした', colors.red);
    return { vulnerabilities: 0 };
  }
  
  const vulnerabilities = auditData.metadata?.vulnerabilities || {};
  const totalVulns = Object.values(vulnerabilities).reduce((sum, count) => sum + count, 0);
  
  if (totalVulns === 0) {
    log('✅ セキュリティ脆弱性は見つかりませんでした', colors.green);
  } else {
    log(`⚠️  ${totalVulns}個のセキュリティ脆弱性が見つかりました:`, colors.yellow);
    Object.entries(vulnerabilities).forEach(([severity, count]) => {
      if (count > 0) {
        log(`   ${severity}: ${count}個`, colors.red);
      }
    });
  }
  
  return { vulnerabilities: totalVulns, details: vulnerabilities };
}

function generateUpdateReport(outdatedPackages, securityData) {
  const timestamp = new Date().toISOString().split('T')[0];
  const reportPath = path.join(__dirname, '..', 'api-update-reports', `report-${timestamp}.md`);
  
  // レポートディレクトリを作成
  const reportDir = path.dirname(reportPath);
  if (!fs.existsSync(reportDir)) {
    fs.mkdirSync(reportDir, { recursive: true });
  }
  
  let report = `# API更新チェックレポート - ${timestamp}\n\n`;
  
  // パッケージ更新情報
  if (outdatedPackages.length > 0) {
    report += `## 更新可能なパッケージ (${outdatedPackages.length}個)\n\n`;
    report += '| パッケージ名 | 現在のバージョン | 推奨バージョン | 最新バージョン |\n';
    report += '|-------------|----------------|----------------|----------------|\n';
    
    outdatedPackages.forEach(pkg => {
      report += `| ${pkg.name} | ${pkg.current} | ${pkg.wanted} | ${pkg.latest} |\n`;
    });
    report += '\n';
  } else {
    report += '## 更新可能なパッケージ\n\n✅ すべてのパッケージが最新バージョンです\n\n';
  }
  
  // セキュリティ情報
  report += `## セキュリティ脆弱性\n\n`;
  if (securityData.vulnerabilities === 0) {
    report += '✅ セキュリティ脆弱性は見つかりませんでした\n\n';
  } else {
    report += `⚠️  ${securityData.vulnerabilities}個のセキュリティ脆弱性が見つかりました\n\n`;
    Object.entries(securityData.details).forEach(([severity, count]) => {
      if (count > 0) {
        report += `- ${severity}: ${count}個\n`;
      }
    });
    report += '\n';
  }
  
  // 推奨アクション
  report += '## 推奨アクション\n\n';
  if (outdatedPackages.length > 0 || securityData.vulnerabilities > 0) {
    report += '1. **セキュリティ更新を優先**: `npm audit fix` を実行\n';
    report += '2. **パッケージ更新**: 影響範囲を確認してから `npm update` を実行\n';
    report += '3. **テスト実行**: 更新後に全機能の動作確認\n';
    report += '4. **ドキュメント更新**: `.cursor/api-reference-rules.md` の更新履歴に記録\n\n';
  } else {
    report += '✅ 現在の状態で問題ありません。次回の定期チェックまで待機してください。\n\n';
  }
  
  report += `---\n\n*このレポートは scripts/check-api-updates.js によって自動生成されました。*\n`;
  
  fs.writeFileSync(reportPath, report);
  log(`\n📄 レポートを生成しました: ${reportPath}`, colors.cyan);
  
  return reportPath;
}

function main() {
  log('🚀 API更新チェックを開始します...', colors.magenta);
  
  // パッケージバージョン確認
  const outdatedPackages = checkOutdatedPackages();
  
  // セキュリティ脆弱性チェック
  const securityData = checkSecurityVulnerabilities();
  
  // レポート生成
  const reportPath = generateUpdateReport(outdatedPackages, securityData);
  
  // サマリー表示
  log('\n📊 チェック結果サマリー:', colors.magenta);
  log(`   更新可能パッケージ: ${outdatedPackages.length}個`, colors.yellow);
  log(`   セキュリティ脆弱性: ${securityData.vulnerabilities}個`, colors.red);
  log(`   レポートファイル: ${reportPath}`, colors.cyan);
  
  if (outdatedPackages.length > 0 || securityData.vulnerabilities > 0) {
    log('\n⚠️  アクションが必要です。レポートを確認して対応してください。', colors.yellow);
    process.exit(1);
  } else {
    log('\n✅ すべてのチェックが完了しました。問題は見つかりませんでした。', colors.green);
    process.exit(0);
  }
}

// スクリプト実行
if (require.main === module) {
  main();
}

module.exports = {
  checkOutdatedPackages,
  checkSecurityVulnerabilities,
  generateUpdateReport
};

