# API リファレンス参照ルール

このプロジェクトで使用されているAPIの最新リファレンスを参照するためのルールです。

## 自動更新チェック仕組み

### 1. 定期的な確認スケジュール
- **月次**: 全APIの公式ドキュメント更新確認
- **四半期**: パッケージバージョンとCHANGELOG確認
- **緊急時**: セキュリティアドバイザリ発生時の即座確認

### 2. 更新確認チェックリスト
```bash
# 自動チェックスクリプト実行（推奨）
npm run check-api

# 手動チェック
npm outdated
npm audit

# 各APIの最新情報確認
# - LINE: https://developers.line.biz/ja/reference/messaging-api/
# - Google Sheets: https://developers.google.com/sheets/api
# - OpenAI: https://platform.openai.com/docs/api-reference
```

### 3. 自動チェックスクリプト
`scripts/check-api-updates.js` を使用して、以下の機能を自動実行：
- パッケージバージョン確認
- セキュリティ脆弱性チェック
- 更新レポート生成
- 推奨アクション表示

### 4. 更新時の対応フロー
1. **情報収集**: 公式ドキュメント・CHANGELOG・GitHubリリースノート確認
2. **影響範囲分析**: 現在のコードへの影響度評価
3. **テスト計画**: 更新前後の動作確認計画
4. **段階的更新**: 開発環境→ステージング→本番の順で適用
5. **ドキュメント更新**: このファイルの更新履歴に記録

## 使用API一覧

### 1. LINE Messaging API
- **パッケージ**: `@line/bot-sdk`
- **バージョン**: ^10.3.0
- **公式ドキュメント**: https://developers.line.biz/ja/reference/messaging-api/
- **GitHub**: https://github.com/line/line-bot-sdk-nodejs
- **主要機能**: 
  - プッシュメッセージ送信
  - リプライメッセージ送信
  - Webhookイベント処理

### 2. Google Sheets API
- **パッケージ**: `googleapis`, `google-spreadsheet`, `google-auth-library`
- **バージョン**: ^160.0.0, ^5.0.2, ^10.4.0
- **公式ドキュメント**: 
  - Google Sheets API: https://developers.google.com/sheets/api
  - google-spreadsheet: https://theoephraim.github.io/node-google-spreadsheet/
  - google-auth-library: https://github.com/googleapis/google-auth-library-nodejs
- **主要機能**:
  - スプレッドシート読み書き
  - 認証（JWT）
  - バルク操作

### 3. OpenAI API
- **パッケージ**: `openai`
- **バージョン**: ^5.23.2
- **公式ドキュメント**: https://platform.openai.com/docs/api-reference
- **GitHub**: https://github.com/openai/openai-node
- **主要機能**:
  - Chat Completions API
  - GPT-4o-mini モデル使用

### 4. Node.js標準ライブラリ
- **crypto**: 暗号化・ハッシュ化
- **node-cron**: スケジュール実行
- **公式ドキュメント**: https://nodejs.org/api/

## リファレンス参照ルール

### 1. 新機能開発時
- 新しいAPI機能を使用する前に、必ず最新の公式ドキュメントを確認する
- 破壊的変更（Breaking Changes）がないか確認する
- 推奨される使用方法を確認する

### 2. バグ修正時
- エラーメッセージやAPIレスポンスが変更されていないか確認する
- 非推奨機能を使用していないか確認する
- 最新のベストプラクティスに従っているか確認する

### 3. 依存関係更新時
- 各パッケージのCHANGELOGを確認する
- 破壊的変更の有無を確認する
- 新しい機能や改善点を確認する

### 4. セキュリティ更新時
- セキュリティアドバイザリを確認する
- 認証方法の変更がないか確認する
- 推奨されるセキュリティ設定を確認する

## 参考リンク

### LINE Messaging API
- [LINE Developers Console](https://developers.line.biz/console/)
- [Webhook設定ガイド](https://developers.line.biz/ja/reference/messaging-api/#webhook)
- [メッセージタイプ一覧](https://developers.line.biz/ja/reference/messaging-api/#message-types)

### Google Sheets API
- [Google Cloud Console](https://console.cloud.google.com/)
- [認証設定ガイド](https://developers.google.com/sheets/api/guides/authorizing)
- [API制限事項](https://developers.google.com/sheets/api/limits)

### OpenAI API
- [OpenAI Platform](https://platform.openai.com/)
- [モデル一覧](https://platform.openai.com/docs/models)
- [料金体系](https://openai.com/pricing)

## 注意事項

1. **API制限**: 各APIにはレート制限があります。大量のリクエストを送信する際は注意してください。

2. **認証情報**: 環境変数で管理されている認証情報は、最新の形式に従ってください。

3. **エラーハンドリング**: APIのエラーレスポンスは変更される可能性があります。適切なエラーハンドリングを実装してください。

4. **ログ出力**: 機密情報（APIキー、トークンなど）をログに出力しないよう注意してください。

5. **テスト**: 新しいAPI機能を使用する際は、必ずテスト環境で動作確認を行ってください。

## 監視・アラート設定

### 1. GitHub Watch設定
各APIライブラリのGitHubリポジトリをWatchして、リリース通知を受け取る：
- `@line/bot-sdk`: https://github.com/line/line-bot-sdk-nodejs
- `googleapis`: https://github.com/googleapis/google-api-nodejs-client
- `google-spreadsheet`: https://github.com/theoephraim/node-google-spreadsheet
- `openai`: https://github.com/openai/openai-node

### 2. セキュリティ監視
- **GitHub Dependabot**: 自動セキュリティ更新通知
- **npm audit**: 脆弱性スキャン
- **Snyk**: 依存関係のセキュリティ監視（オプション）

### 3. 変更通知の受け取り方
- **メール通知**: GitHub Watch設定でリリース通知
- **Slack/Discord**: ボット連携で自動通知（推奨）
- **定期チェック**: 月次での手動確認

## 緊急時対応手順

### 1. セキュリティ脆弱性発見時
```bash
# 1. 即座に脆弱性確認
npm audit

# 2. 影響範囲確認
npm audit --audit-level=moderate

# 3. 自動修正試行
npm audit fix

# 4. 手動修正が必要な場合
npm audit fix --force
```

### 2. 破壊的変更対応時
1. **バックアップ作成**: 現在の動作するバージョンをコミット
2. **テスト環境で検証**: 新バージョンでの動作確認
3. **段階的移行**: 機能ごとに順次移行
4. **ロールバック準備**: 問題発生時の復旧手順準備

## 更新履歴

- 2024-12-19: 初版作成（自動更新チェック仕組み追加）
- 2024-12-19: 監視・アラート設定、緊急時対応手順追加

### 次回確認予定
- **2025-01-19**: 月次API更新確認
- **2025-03-19**: 四半期パッケージバージョン確認
