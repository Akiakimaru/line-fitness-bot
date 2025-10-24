# 🔧 LINE Fitness Bot 管理者ガイド

## 📋 目次
1. [システム構成](#-システム構成)
2. [環境設定](#-環境設定)
3. [API仕様](#-api仕様)
4. [データベース構造](#-データベース構造)
5. [デプロイメント](#-デプロイメント)
6. [監視・ログ](#-監視ログ)
7. [トラブルシューティング](#-トラブルシューティング)

---

## 🏗️ システム構成

### 📁 ディレクトリ構造
```
line-fitness-bot/
├── index.js                 # メインエントリーポイント
├── services/
│   ├── lineHandlers.js      # LINE Bot イベント処理
│   └── scheduler.js         # 定期実行タスク
├── lib/
│   ├── sheets.js           # Google Sheets API
│   ├── llm.js              # OpenAI API
│   └── utils.js            # ユーティリティ関数
├── routes/
│   └── admin.js            # 管理API・マイページ
├── public/                 # 静的ファイル
├── docs/                   # ドキュメント
└── hiit-plan.html         # HIITプラン静的ページ
```

### 🔄 アーキテクチャ
```
LINE Bot ←→ Express Server ←→ Google Sheets
                ↓
            OpenAI API
                ↓
            Static Pages
```

---

## ⚙️ 環境設定

### 🔑 必須環境変数
```bash
# LINE Bot設定
LINE_CHANNEL_SECRET=your_channel_secret
LINE_CHANNEL_ACCESS_TOKEN=your_access_token

# Google Sheets設定
GOOGLE_SHEETS_CREDENTIALS_JSON={"type":"service_account",...}
GOOGLE_SHEETS_ID=your_sheets_id

# OpenAI設定
OPENAI_API_KEY=your_openai_api_key

# セキュリティ設定
MYPAGE_SECRET=your_hmac_secret
ADMIN_KEY=your_admin_key

# デプロイ設定
PUBLIC_BASE_URL=https://your-domain.com
RENDER_EXTERNAL_URL=https://your-app.onrender.com
```

### 📊 Google Sheets構造
```
Users_YYYY-MM-DD/
├── A: UserId
├── B: Name
├── C: RegisteredAt
└── D: LastActiveAt

Logs_YYYY-MM-DD/
├── A: DateTime
├── B: UserId
├── C: Kind (Meal/Gym/Weight)
├── D: Text
└── E: MetaJSON

MealPlan_YYYY-MM-DD/
├── A: Week
├── B: Day
├── C: Slot
├── D: Menu
└── E: GeneratedAt
```

---

## 🔌 API仕様

### 📱 LINE Webhook
```
POST /webhook
Content-Type: application/json
X-Line-Signature: signature

{
  "events": [
    {
      "type": "message",
      "source": {"userId": "U123..."},
      "message": {"type": "text", "text": "食事"}
    }
  ]
}
```

### 🔐 管理API

#### ユーザー一覧
```
GET /admin/users?key=admin_key
Response: {
  "ok": true,
  "users": [
    {
      "UserId": "U123...",
      "Name": "User Name",
      "RegisteredAt": "2025-01-01T00:00:00.000Z",
      "LastActiveAt": "2025-01-01T00:00:00.000Z"
    }
  ]
}
```

#### ログ一覧
```
GET /admin/logs?key=admin_key&days=7
Response: {
  "ok": true,
  "logs": [
    {
      "DateTime": "2025-01-01T00:00:00.000Z",
      "UserId": "U123...",
      "Kind": "Meal",
      "Text": "朝食：パン、コーヒー",
      "MetaJSON": "{\"time\":\"07:30\"}"
    }
  ]
}
```

#### 統計情報
```
GET /admin/stats?key=admin_key
Response: {
  "ok": true,
  "stats": {
    "totalUsers": 100,
    "activeUsers": 50,
    "totalLogs": 1000,
    "logsByKind": {
      "Meal": 600,
      "Gym": 300,
      "Weight": 100
    }
  }
}
```

### 👤 ユーザーAPI（署名付き）

#### ユーザーサマリー
```
GET /user/summary?uid=user_id&exp=expiry&sig=signature
Response: {
  "ok": true,
  "meals": 21,
  "gymSets": 15,
  "gymMinutes": 300,
  "weight": {
    "avg": 65.5,
    "min": 64.0,
    "max": 67.0
  }
}
```

#### ユーザーログ
```
GET /user/logs?uid=user_id&exp=expiry&sig=signature&days=7
Response: {
  "ok": true,
  "logs": [...]
}
```

---

## 🗄️ データベース構造

### 📊 データフロー
```
LINE Event → lineHandlers.js → sheets.js → Google Sheets
                ↓
            Response to LINE
```

### 🔄 定期実行タスク
```javascript
// 毎朝5時: ジムリマインド
cron.schedule("0 5 * * *", () => pushSlot("ジム"));

// 毎夜21時: 食事リマインド  
cron.schedule("0 21 * * *", () => pushSlot("食事"));

// 毎週日曜日: メニュー生成
cron.schedule("0 0 * * 0", () => generateWeeklyMenu());
```

### 📝 ログ形式
```javascript
{
  "DateTime": "2025-01-01T00:00:00.000Z",
  "UserId": "U123...",
  "Kind": "Meal|Gym|Weight",
  "Text": "記録内容",
  "MetaJSON": "{\"time\":\"07:30\",\"parsed\":{...}}"
}
```

---

## 🚀 デプロイメント

### 🌐 Render設定
```yaml
# render.yaml
services:
  - type: web
    name: line-fitness-bot
    env: node
    buildCommand: npm install
    startCommand: npm start
    envVars:
      - key: NODE_ENV
        value: production
```

### 📦 パッケージ管理
```json
{
  "scripts": {
    "start": "node index.js",
    "dev": "nodemon index.js",
    "test": "jest",
    "lint": "eslint .",
    "typecheck": "tsc --noEmit"
  }
}
```

### 🔄 CI/CD
1. **Git Push** → GitHub
2. **Render** → 自動デプロイ
3. **Health Check** → `/health` エンドポイント
4. **ログ監視** → Render Dashboard

---

## 📊 監視・ログ

### 📝 ログレベル
```javascript
// 構造化ログ
logger.info('User action', {
  userId: 'U123...',
  action: 'meal_log',
  timestamp: new Date().toISOString(),
  metadata: { mealType: 'breakfast' }
});
```

### 🔍 監視項目
- **レスポンス時間**: < 2秒
- **エラー率**: < 1%
- **メモリ使用量**: < 512MB
- **CPU使用率**: < 80%

### 📈 メトリクス
- **アクティブユーザー数**
- **メッセージ処理数**
- **API呼び出し数**
- **エラー発生数**

---

## 🆘 トラブルシューティング

### ❌ よくある問題

#### LINE Bot応答なし
```bash
# ログ確認
tail -f logs/app.log

# 環境変数確認
echo $LINE_CHANNEL_SECRET
echo $LINE_CHANNEL_ACCESS_TOKEN
```

#### Google Sheets接続エラー
```bash
# 認証情報確認
echo $GOOGLE_SHEETS_CREDENTIALS_JSON | jq .

# スプレッドシートID確認
echo $GOOGLE_SHEETS_ID
```

#### マイページ認証エラー
```bash
# HMAC秘密鍵確認
echo $MYPAGE_SECRET

# 署名検証ログ確認
grep "verifyUserLink" logs/app.log
```

### 🔧 デバッグ手順

#### 1. ログ確認
```bash
# リアルタイムログ
tail -f logs/app.log

# エラーログのみ
grep "ERROR" logs/app.log
```

#### 2. 環境変数確認
```bash
# 全環境変数表示
env | grep -E "(LINE|GOOGLE|OPENAI|MYPAGE|ADMIN)"
```

#### 3. ヘルスチェック
```bash
# サーバー状態確認
curl https://your-app.onrender.com/health

# 管理API確認
curl "https://your-app.onrender.com/admin/stats?key=your_admin_key"
```

### 🚨 緊急時対応

#### 1. サービス停止
```bash
# Render Dashboard → Service → Suspend
# または
# 環境変数で緊急停止フラグを設定
```

#### 2. データ復旧
```bash
# Google Sheetsから直接データ確認
# バックアップから復旧
```

#### 3. ロールバック
```bash
# Render Dashboard → Deploys → 前のバージョンに戻す
```

---

## 📚 参考資料

### 🔗 外部API
- [LINE Messaging API](https://developers.line.biz/ja/reference/messaging-api/)
- [Google Sheets API](https://developers.google.com/sheets/api)
- [OpenAI API](https://platform.openai.com/docs/api-reference)

### 📖 ドキュメント
- [Express.js](https://expressjs.com/)
- [node-cron](https://github.com/node-cron/node-cron)
- [google-spreadsheet](https://github.com/theoephraim/node-google-spreadsheet)

---

**最終更新**: 2025年1月  
**バージョン**: 1.0  
**対象**: システム管理者
