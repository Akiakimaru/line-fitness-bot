// lib/middleware.js - 共通ミドルウェア
const { adminAuthMiddleware, userAuthMiddleware } = require('./auth');

/**
 * エラーハンドリングミドルウェア
 */
function errorHandler(error, req, res, next) {
  console.error(`[Error] ${req.method} ${req.path}:`, error);
  
  // エラーの種類に応じて適切なレスポンスを返す
  if (error.name === 'ValidationError') {
    return res.status(400).json({
      ok: false,
      error: 'Validation Error',
      details: error.message
    });
  }
  
  if (error.name === 'UnauthorizedError') {
    return res.status(401).json({
      ok: false,
      error: 'Unauthorized',
      message: '認証が必要です'
    });
  }
  
  // デフォルトエラー
  res.status(500).json({
    ok: false,
    error: 'Internal Server Error',
    message: process.env.NODE_ENV === 'development' ? error.message : 'サーバーエラーが発生しました'
  });
}

/**
 * リクエストログミドルウェア
 */
function requestLogger(req, res, next) {
  const start = Date.now();
  const originalSend = res.send;
  
  res.send = function(data) {
    const duration = Date.now() - start;
    console.log(`[${req.method}] ${req.path} - ${res.statusCode} (${duration}ms)`);
    originalSend.call(this, data);
  };
  
  next();
}

/**
 * CORS設定ミドルウェア
 */
function corsMiddleware(req, res, next) {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  
  if (req.method === 'OPTIONS') {
    res.sendStatus(200);
  } else {
    next();
  }
}

/**
 * レート制限ミドルウェア（簡易版）
 */
const rateLimitMap = new Map();

function rateLimitMiddleware(windowMs = 60000, maxRequests = 100) {
  return (req, res, next) => {
    const clientId = req.ip || req.connection.remoteAddress;
    const now = Date.now();
    const windowStart = now - windowMs;
    
    // 古いエントリを削除
    if (rateLimitMap.has(clientId)) {
      const requests = rateLimitMap.get(clientId).filter(time => time > windowStart);
      rateLimitMap.set(clientId, requests);
    } else {
      rateLimitMap.set(clientId, []);
    }
    
    const requests = rateLimitMap.get(clientId);
    
    if (requests.length >= maxRequests) {
      return res.status(429).json({
        ok: false,
        error: 'Too Many Requests',
        message: 'リクエスト制限に達しました。しばらく待ってから再試行してください。'
      });
    }
    
    requests.push(now);
    next();
  };
}

/**
 * 静的ファイル配信の設定
 */
function staticFileConfig() {
  return {
    maxAge: '1d', // 1日間キャッシュ
    etag: true,
    lastModified: true
  };
}

module.exports = {
  errorHandler,
  requestLogger,
  corsMiddleware,
  rateLimitMiddleware,
  staticFileConfig,
  adminAuthMiddleware,
  userAuthMiddleware
};
