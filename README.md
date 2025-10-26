# LINE Fitness Bot

LINEを起点としたフィットネス管理ボット。トレーニング・栄養・リマインドの自動配信、Google Sheets連携、AI生成メニュー、静的ページ配信を提供します。

## 🚀 機能概要

### コア機能
- **週間メニュー生成**: AI（GPT-4o-mini）による食事・トレーニングメニューの自動生成
- **定時配信**: cron による朝・昼・夜・就寝・ジム時間の自動通知
- **ログ記録**: 食事・ジム・体重の記録とGoogle Sheetsへの保存
- **管理画面**: ユーザー管理、ログ閲覧、手動配信機能
- **マイページ**: 個人用ダッシュボード（署名付きリンク）
- **HIITプラン**: 20分サイクリングHIITの詳細プランページ

### 技術仕様
- **Backend**: Node.js + Express
- **Database**: Google Sheets API
- **Messaging**: LINE Messaging API
- **Hosting**: Render
- **AI**: OpenAI GPT-4o-mini
- **Static Pages**: HTML/CSS/JS（モバイルファースト）

## 📁 プロジェクト構造

```
/
├── index.js                 # サーバーエントリーポイント
├── services/
│   ├── lineHandlers.js     # LINE イベント処理
│   └── scheduler.js        # cron ジョブ管理
├── lib/
│   ├── sheets.js           # Google Sheets 連携
│   ├── llm.js              # AI 生成処理
│   └── utils.js            # ユーティリティ関数
├── routes/
│   └── admin.js            # 管理API
├── public/                 # 静的ファイル
│   └── hiit-plan.html      # HIITプランページ
├── .cursorrules            # Cursor開発ガイドライン
├── .env.example            # 環境変数テンプレート
└── README.md               # このファイル
```

## 🛠️ セットアップ

### 1. リポジトリクローン
```bash
git clone <repository-url>
cd line-fitness-bot
```

### 2. 依存関係インストール
```bash
npm install
```

### 3. 環境変数設定
```bash
cp .env.example .env
# .envファイルを編集して必要な値を設定
```

### 4. 開発サーバー起動
```bash
npm run dev
```

## 🔧 環境変数

### 必須設定
```bash
# LINE Bot設定
LINE_CHANNEL_ACCESS_TOKEN=your_channel_access_token
LINE_CHANNEL_SECRET=your_channel_secret

# Google Sheets設定
GOOGLE_SHEET_ID=your_sheet_id
GOOGLE_SERVICE_ACCOUNT_JSON={"type":"service_account",...}

# OpenAI設定
OPENAI_API_KEY=your_openai_api_key

# 管理設定
ADMIN_KEY=your_admin_key
MYPAGE_SECRET=your_mypage_secret

# その他
START_DATE=2024-01-01
PUBLIC_BASE_URL=https://your-app.onrender.com
```

### オプション設定
```bash
# Render設定（自動設定）
RENDER_EXTERNAL_URL=https://your-app.onrender.com
```

## 📱 LINE Bot コマンド

### 基本コマンド
- **食事**: 食事ログ記録（PFC自動分析）
- **ジム**: ジムログ記録（AM5時基準で日付換算）
- **体重**: 体重記録
- **今日のメニュー**: 当日のメニュー表示
- **マイページ**: 個人ダッシュボード（ジムカレンダー付き）
- **フィードバック**: 週間記録のAI分析
- **買い出し計画**: 週間メニュー＆買い物リスト生成
- **HIIT**: HIITプランページ

### ログ記録例
```
食事
ヨーグルト

ジム
ベンチプレス 50*10 60*8
トレッドミル 15分

体重 79.2
```

### 特殊機能
- **ジムログの日付換算**: AM5:00〜翌日AM4:59を同じ日として記録
  - 例：10/9 AM3:00 → 10/8として換算
- **複数ログの自動合算**: 同日の複数記録を統合表示
- **ジムカレンダー**: マイページのカレンダーから日別詳細を確認可能

## 🔗 API エンドポイント

### 公開エンドポイント
- `GET /` - ヘルスチェック
- `GET /hiit-plan.html` - HIITプランページ
- `GET /mypage` - マイページ（署名付き）
- `GET /gym-menu` - ジムメニューページ（署名付き）
- `GET /food-db` - 食品データベース（署名付き）
- `GET /shopping-plan-view` - 買い出し計画表示（署名付き）
- `GET /guide` - 使い方ガイド（署名付き）

### ユーザーAPI（署名認証）
- `GET /user/logs?uid=...&days=7` - ユーザーログ取得
- `GET /user/summary?uid=...&days=7` - ユーザーサマリー取得
- `GET /user/gym-detail?uid=...&date=YYYY-MM-DD` - **特定日のジムログ詳細（NEW）**
- `GET /user/food-db?search=...` - 食品データベース検索
- `GET /user/shopping-plan?uid=...` - 買い出し計画取得

### 管理エンドポイント（認証必須）
- `GET /admin/dashboard?key=...` - 管理ダッシュボード
- `GET /admin/users?key=...` - ユーザー一覧
- `GET /admin/logs?key=...` - ログ一覧
- `GET /admin/stats?key=...` - 統計情報
- `GET /admin/today?key=...` - 今日のメニュー
- `GET /admin/auto-gen?key=...` - 次週メニュー生成
- `GET /admin/push-slot?slot=昼&key=...` - 手動配信

## 🗄️ データ構造

### Google Sheets構成
- **MealPlan**: 週間メニューデータ
- **Users**: ユーザー情報
- **Logs**: ログデータ（DateTime, UserId, Kind, Text, Meta, PFCJSON, ConfidenceScore）
- **ShoppingPlan**: 買い出し計画（Week, UserId, GeneratedAt, ValidFrom, ValidUntil, PlanJSON, Status）
- **DailyMenu**: 日次メニュー（Date, Week, Day, Slot, MenuName, IngredientsJSON, Recipe, CookingTime, PFCJSON, SourcePlan）

### ログデータ形式
```json
{
  "DateTime": "2024-01-01T12:00:00.000Z",
  "UserId": "U123...",
  "Kind": "Meal|Gym|Weight",
  "Text": "記録内容",
  "Meta": {"sets": 15, "minutes": 60},
  "PFCJSON": "{\"protein\":25,\"fat\":10,\"carbs\":30}",
  "ConfidenceScore": 0.85
}
```

### ジムログ詳細API レスポンス
```json
{
  "ok": true,
  "data": {
    "date": "2025-10-26",
    "logs": [...],
    "totalSets": 15,
    "totalMinutes": 60,
    "exercises": [
      {
        "name": "ベンチプレス",
        "sets": 3,
        "reps": [10, 8, 6],
        "weights": [60, 70, 80],
        "avgReps": 8,
        "avgWeight": 70
      }
    ]
  }
}
```

## 🚀 デプロイメント

### Render デプロイ
1. GitHubリポジトリをRenderに接続
2. 環境変数を設定
3. 自動デプロイ有効化

### 環境変数設定（Render）
- 管理画面の「Environment」タブで設定
- 機密情報は「Secret」として設定

## 🔍 監視・ログ

### ログ確認
- Render Dashboard → Logs タブ
- 構造化ログで検索・フィルタリング可能

### ヘルスチェック
- `GET /` でサーバー状態確認
- 管理ダッシュボードで詳細情報確認

## 🐛 トラブルシューティング

### よくある問題

#### LINE返信が止まった
1. Renderログでエラー確認
2. Webhook URL設定確認
3. チャネル権限確認
4. 環境変数確認

#### CSV生成失敗
1. ヘッダ検証ログ確認
2. OpenAI API制限確認
3. Google Sheets権限確認

#### 管理画面アクセス不可
1. ADMIN_KEY設定確認
2. URLパラメータ確認
3. 認証ログ確認

### ログレベル
- `INFO`: 正常動作
- `WARN`: 注意事項
- `ERROR`: エラー（要対応）
- `DEBUG`: デバッグ情報

## 🔄 開発ワークフロー

### 1. 機能開発
```bash
# ブランチ作成
git checkout -b feat/feature-name

# 開発・テスト
npm run dev
npm test

# コミット・プッシュ
git add .
git commit -m "feat: add new feature"
git push origin feat/feature-name
```

### 2. バグ修正
```bash
# ブランチ作成
git checkout -b fix/bug-description

# 修正・テスト
# テストケース追加

# コミット・プッシュ
git add .
git commit -m "fix: resolve bug description"
git push origin fix/bug-description
```

## 📊 パフォーマンス

### 制限事項
- **LINE API**: 1000メッセージ/秒
- **Google Sheets**: 100リクエスト/100秒
- **OpenAI**: 制限あり（プランによる）

### 最適化
- バッチ処理でAPI呼び出し削減
- キャッシュで重複処理回避
- 非同期処理でレスポンス向上

## 🔐 セキュリティ

### 認証・認可
- 管理API: ADMIN_KEY認証
- マイページ: HMAC署名認証
- 環境変数: 機密情報管理

### データ保護
- ユーザーID: 平文露出禁止
- ログ: 機密情報除外
- 通信: HTTPS必須

## 📈 今後の拡張計画

### Phase 1: 基盤整備
- [ ] TypeScript移行
- [ ] CSVバリデーション強化
- [ ] 送信冪等化
- [ ] 管理API認証強化

### Phase 2: 機能拡張
- [ ] プレイリスト自動生成
- [ ] 体調連動強度調整
- [ ] 可視化ダッシュボード
- [ ] 多言語対応

### Phase 3: 高度化
- [ ] 機械学習による最適化
- [ ] 外部サービス連携拡張
- [ ] モバイルアプリ化
- [ ] リアルタイム通知

## 📞 サポート

### 開発者向け
- コードレビュー: PR作成時
- 技術相談: チーム内Slack
- ドキュメント: このREADME + .cursorrules

### ユーザー向け
- ヘルプ: LINE Bot内で案内
- フィードバック: 管理画面から収集
- サポート: 管理者経由

## 📄 ライセンス

MIT License

## 🤝 コントリビューション

1. このリポジトリをフォーク
2. 機能ブランチを作成 (`git checkout -b feat/amazing-feature`)
3. 変更をコミット (`git commit -m 'Add amazing feature'`)
4. ブランチにプッシュ (`git push origin feat/amazing-feature`)
5. プルリクエストを作成

---

**注意**: 本プロジェクトは開発中です。本番環境での使用前に十分なテストを行ってください。
