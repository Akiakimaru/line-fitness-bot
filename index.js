<<<<<<< HEAD
// index.js
require('dotenv').config();
const express = require('express');
const line = require('@line/bot-sdk');
const OpenAI = require('openai');
const cron = require('node-cron');

// ====== LINE / OpenAI 基本設定 ======
const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};
const client = new line.Client(config);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ====== アプリ本体 ======
const app = express();

// （簡易）最後に話しかけたユーザーの userId を保持（本番はDBに保存推奨）
let LAST_USER_ID = null;

// ---- Webhook ----
app.post('/webhook', line.middleware(config), async (req, res) => {
  try {
    await Promise.all(req.body.events.map(handleEvent));
    res.sendStatus(200);
  } catch (e) {
    console.error('handleEvent error', e);
    res.sendStatus(500);
  }
});

// ---- 受信イベント処理 ----
async function handleEvent(e) {
  if (e.source?.userId) LAST_USER_ID = e.source.userId;
  if (e.type !== 'message') return;

  // 画像 → OpenAIで厳しめ栄養FB
  if (e.message.type === 'image') {
    try {
      const dataUrl = await fetchImageAsDataUrl(e.message.id);
      const fb = await feedbackFromImage(dataUrl);
      return client.replyMessage(e.replyToken, { type: 'text', text: `【FB】\n${fb}` });
    } catch (err) {
      console.error('image handle error:', err);
      const fallback =
        '画像を受け取った。画質かサイズが悪い可能性がある。明るく全体が分かるように撮り直せ。';
      return client.replyMessage(e.replyToken, { type: 'text', text: `【FB】\n${fallback}` });
    }
  }

  // テキスト → コマンド分岐 or 厳しめテンプレ + クイックリプライ
  if (e.message.type === 'text') {
    const t = (e.message.text || '').trim();

    // --- コマンド: 今日の昼 ---
    if (t.includes('今日の昼')) {
      const reply =
`【今日の昼】
玄米150g＋刺身100〜150g（8〜12切れ）＋サラダ。
ドレッシングはノンオイル。食後10分以内に20分歩け。手を止めるな。`;
      return client.replyMessage(e.replyToken, { type: 'text', text: reply });
    }

    // --- コマンド: 今日のジム（曜日で切替 0=日…6=土） ---
    if (t.includes('今日のジム')) {
      const day = new Date().getDay();
      const plan = gymPlanByDay(day);
      const reply =
`【今日のジム】
${plan}
重量に逃げるな。可動域とテンポを守れ。終わったらバイク20分。`;
      return client.replyMessage(e.replyToken, { type: 'text', text: reply });
    }

    // --- コマンド: 就寝前 ---
    if (t.includes('就寝前')) {
      const reply =
`【就寝前】
ギリシャヨーグルト100g＋プロテイン1杯。
明朝のウェア・水・シェイカーを玄関に用意。23:00で電源を落とせ。`;
      return client.replyMessage(e.replyToken, { type: 'text', text: reply });
    }

    // --- デフォ: 厳しめ + クイックリプライ表示 ---
    const quick = {
      type: 'text',
      text: `受信：「${t}」\n写真で証拠を出せ。今すぐ動け。`,
      quickReply: {
        items: [
          { type: 'action', action: { type: 'message', label: '今日の昼', text: '今日の昼' } },
          { type: 'action', action: { type: 'message', label: '今日のジム', text: '今日のジム' } },
          { type: 'action', action: { type: 'message', label: '就寝前', text: '就寝前' } },
        ]
      }
    };
    return client.replyMessage(e.replyToken, quick);
  }

  return Promise.resolve(null);
}

// ====== 画像 → Base64 DataURL 変換 ======
async function fetchImageAsDataUrl(messageId) {
  const stream = await client.getMessageContent(messageId);
  const chunks = [];
  for await (const c of stream) chunks.push(c);
  const buf = Buffer.concat(chunks);

  // 簡易MIME判定（PNG/JPEG）
  const isPng = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  const mime = isPng ? 'image/png' : 'image/jpeg';
  const b64 = buf.toString('base64');
  return `data:${mime};base64,${b64}`;
}

// ====== OpenAIで画像評価（厳しめ2〜4行） ======
async function feedbackFromImage(dataUrl) {
  const prompt =
`料理・飲み物・スイーツ含め、どんな写真でも必ず評価せよ。減量中（たんぱく質150〜160g/日想定）。
必ず出力：
1) 量の妥当性（スイーツ/外食でも可）
2) ざっくりPFC推定（おおよそで良い）
3) 改善提案（刺身/鶏むね/玄米/さつまいも等で置換）
4) 次回の盛付け指示（gや切れ数）
・謝罪は不要。厳しめ日本語で簡潔に2〜4行。`;

  const res = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0.3,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: dataUrl } },
      ]
    }],
  });

  const out = res.choices?.[0]?.message?.content?.trim();
  if (!out) throw new Error('empty_openai_output');
  const lines = out.split('\n').filter(Boolean).slice(0, 4);
  return lines.join('\n');
}

// ====== 曜日別ジムメニュー（例） ======
function gymPlanByDay(day) {
  // 0=日 1=月 2=火 3=水 4=木 5=金 6=土
  switch (day) {
    case 1: return `Push（胸・肩・三頭）
1. ベンチプレス 5×10
2. インクラインDB 3×10
3. ショルダープレス 3×10
4. サイドレイズ 3×12
5. プレスダウン 3×12`;
    case 2: return `Pull（背中・二頭）
1. デッドリフト 4×10
2. ラットプルダウン 4×10
3. バーベルロー 3×10
4. ダンベルカール 3×12
5. アブバイシクル 3×30`;
    case 3: return `Legs（脚）
1. スクワット 5×10
2. スプリットスクワット 3×10/脚
3. レッグカール 3×12
4. レッグエクステンション 3×12
5. アブバイシクル 3×30`;
    case 4: return `Push（胸・肩・三頭）※軽めフォーム重視
1. ベンチ 4×10（重量控えめ）
2. インクラインDB 3×12
3. ショルダープレス 3×10
4. サイドレイズ 3×15
5. キックバック 3×12`;
    case 5: return `Pull（背中・二頭）
1. デッド 4×8
2. ラットプル 4×10
3. シーテッドロー 3×10
4. EZカール 3×12
5. アブバイシクル 3×30`;
    case 6: return `Full＋有酸素ロング
1. ベンチ 3×10
2. スクワット 3×10
3. ラットプル 3×10
4. ショルダープレス 3×10
5. バイク 30〜40分`;
    case 0: default: return `休養（ストレッチ＆散歩30分）
関節を休めろ。栄養・睡眠を優先。`;
  }
}

// ====== Push送信：テスト用エンドポイント ======
app.get('/push-test', async (_req, res) => {
  try {
    if (!LAST_USER_ID) return res.status(400).send('userId未取得。Botに一度話しかけて。');
    await client.pushMessage(LAST_USER_ID, {
      type: 'text',
      text: '【テストPush】起きろ。水500ml＋EAAを飲んでジムに行け。'
    });
    res.send('OK');
  } catch (e) {
    console.error('push error', e);
    res.status(500).send('NG');
  }
});

// ====== 定時リマインド（JST） ======
// 1日7回：05:50 / 06:05 / 07:20 / 12:00 / 15:00 / 20:00 / 22:30
// ngrok運用中はPC起動中のみ動く。本番はサーバ常時稼働に。
const TZ = 'Asia/Tokyo';
const schedules = [
  { cron: '50 5 * * *', text: '【起床】水500ml＋EAA。着替えたら即出発。言い訳は捨てろ。', tz: TZ },
  { cron: '5 6 * * *',  text: '【ジム前】動的ストレッチ→本日のメニュー実施。重量に逃げるな。', tz: TZ },
  { cron: '20 7 * * *', text: '【朝食】プロテイン→オートミール/おかゆローテで調理。写真を送れ。', tz: TZ },
  { cron: '0 12 * * *', text: '【昼】玄米150g＋刺身100〜150g（8〜12切れ）。食後20分歩け。', tz: TZ },
  { cron: '0 15 * * *', text: '【補食】プロテイン＋ナッツ10粒。軽HIIT or ストレッチ。', tz: TZ },
  { cron: '0 20 * * *', text: '【夕】鶏むね120g＋豆腐＋サラダ。ゆっくり噛め。水分チェック。', tz: TZ },
  { cron: '30 22 * * *', text: '【就寝前】ヨーグルト＋プロテイン。明朝準備。23:00で電源OFF。', tz: TZ },
];

for (const s of schedules) {
  cron.schedule(s.cron, async () => {
    try {
      if (!LAST_USER_ID) return; // まだ誰も話しかけていない
      await client.pushMessage(LAST_USER_ID, { type: 'text', text: s.text });
    } catch (err) {
      console.error('cron push error', err);
    }
  }, { timezone: s.tz });
}

// ---- Liveness ----
app.get('/', (_req, res) => res.send('OK'));
app.listen(process.env.PORT || 3000, () => console.log('Server OK'));
=======
// index.js
require('dotenv').config();
const express = require('express');
const line = require('@line/bot-sdk');
const OpenAI = require('openai');
const cron = require('node-cron');

// ====== LINE / OpenAI 基本設定 ======
const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};
const client = new line.Client(config);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ====== アプリ本体 ======
const app = express();

// （簡易）最後に話しかけたユーザーの userId を保持（本番はDBに保存推奨）
let LAST_USER_ID = null;

// ---- Webhook ----
app.post('/webhook', line.middleware(config), async (req, res) => {
  try {
    await Promise.all(req.body.events.map(handleEvent));
    res.sendStatus(200);
  } catch (e) {
    console.error('handleEvent error', e);
    res.sendStatus(500);
  }
});

// ---- 受信イベント処理 ----
async function handleEvent(e) {
  if (e.source?.userId) LAST_USER_ID = e.source.userId;
  if (e.type !== 'message') return;

  // 画像 → OpenAIで厳しめ栄養FB
  if (e.message.type === 'image') {
    try {
      const dataUrl = await fetchImageAsDataUrl(e.message.id);
      const fb = await feedbackFromImage(dataUrl);
      return client.replyMessage(e.replyToken, { type: 'text', text: `【FB】\n${fb}` });
    } catch (err) {
      console.error('image handle error:', err);
      const fallback =
        '画像を受け取った。画質かサイズが悪い可能性がある。明るく全体が分かるように撮り直せ。';
      return client.replyMessage(e.replyToken, { type: 'text', text: `【FB】\n${fallback}` });
    }
  }

  // テキスト → コマンド分岐 or 厳しめテンプレ + クイックリプライ
  if (e.message.type === 'text') {
    const t = (e.message.text || '').trim();

    // --- コマンド: 今日の昼 ---
    if (t.includes('今日の昼')) {
      const reply =
`【今日の昼】
玄米150g＋刺身100〜150g（8〜12切れ）＋サラダ。
ドレッシングはノンオイル。食後10分以内に20分歩け。手を止めるな。`;
      return client.replyMessage(e.replyToken, { type: 'text', text: reply });
    }

    // --- コマンド: 今日のジム（曜日で切替 0=日…6=土） ---
    if (t.includes('今日のジム')) {
      const day = new Date().getDay();
      const plan = gymPlanByDay(day);
      const reply =
`【今日のジム】
${plan}
重量に逃げるな。可動域とテンポを守れ。終わったらバイク20分。`;
      return client.replyMessage(e.replyToken, { type: 'text', text: reply });
    }

    // --- コマンド: 就寝前 ---
    if (t.includes('就寝前')) {
      const reply =
`【就寝前】
ギリシャヨーグルト100g＋プロテイン1杯。
明朝のウェア・水・シェイカーを玄関に用意。23:00で電源を落とせ。`;
      return client.replyMessage(e.replyToken, { type: 'text', text: reply });
    }

    // --- デフォ: 厳しめ + クイックリプライ表示 ---
    const quick = {
      type: 'text',
      text: `受信：「${t}」\n写真で証拠を出せ。今すぐ動け。`,
      quickReply: {
        items: [
          { type: 'action', action: { type: 'message', label: '今日の昼', text: '今日の昼' } },
          { type: 'action', action: { type: 'message', label: '今日のジム', text: '今日のジム' } },
          { type: 'action', action: { type: 'message', label: '就寝前', text: '就寝前' } },
        ]
      }
    };
    return client.replyMessage(e.replyToken, quick);
  }

  return Promise.resolve(null);
}

// ====== 画像 → Base64 DataURL 変換 ======
async function fetchImageAsDataUrl(messageId) {
  const stream = await client.getMessageContent(messageId);
  const chunks = [];
  for await (const c of stream) chunks.push(c);
  const buf = Buffer.concat(chunks);

  // 簡易MIME判定（PNG/JPEG）
  const isPng = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  const mime = isPng ? 'image/png' : 'image/jpeg';
  const b64 = buf.toString('base64');
  return `data:${mime};base64,${b64}`;
}

// ====== OpenAIで画像評価（厳しめ2〜4行） ======
async function feedbackFromImage(dataUrl) {
  const prompt =
`料理・飲み物・スイーツ含め、どんな写真でも必ず評価せよ。減量中（たんぱく質150〜160g/日想定）。
必ず出力：
1) 量の妥当性（スイーツ/外食でも可）
2) ざっくりPFC推定（おおよそで良い）
3) 改善提案（刺身/鶏むね/玄米/さつまいも等で置換）
4) 次回の盛付け指示（gや切れ数）
・謝罪は不要。厳しめ日本語で簡潔に2〜4行。`;

  const res = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0.3,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: dataUrl } },
      ]
    }],
  });

  const out = res.choices?.[0]?.message?.content?.trim();
  if (!out) throw new Error('empty_openai_output');
  const lines = out.split('\n').filter(Boolean).slice(0, 4);
  return lines.join('\n');
}

// ====== 曜日別ジムメニュー（例） ======
function gymPlanByDay(day) {
  // 0=日 1=月 2=火 3=水 4=木 5=金 6=土
  switch (day) {
    case 1: return `Push（胸・肩・三頭）
1. ベンチプレス 5×10
2. インクラインDB 3×10
3. ショルダープレス 3×10
4. サイドレイズ 3×12
5. プレスダウン 3×12`;
    case 2: return `Pull（背中・二頭）
1. デッドリフト 4×10
2. ラットプルダウン 4×10
3. バーベルロー 3×10
4. ダンベルカール 3×12
5. アブバイシクル 3×30`;
    case 3: return `Legs（脚）
1. スクワット 5×10
2. スプリットスクワット 3×10/脚
3. レッグカール 3×12
4. レッグエクステンション 3×12
5. アブバイシクル 3×30`;
    case 4: return `Push（胸・肩・三頭）※軽めフォーム重視
1. ベンチ 4×10（重量控えめ）
2. インクラインDB 3×12
3. ショルダープレス 3×10
4. サイドレイズ 3×15
5. キックバック 3×12`;
    case 5: return `Pull（背中・二頭）
1. デッド 4×8
2. ラットプル 4×10
3. シーテッドロー 3×10
4. EZカール 3×12
5. アブバイシクル 3×30`;
    case 6: return `Full＋有酸素ロング
1. ベンチ 3×10
2. スクワット 3×10
3. ラットプル 3×10
4. ショルダープレス 3×10
5. バイク 30〜40分`;
    case 0: default: return `休養（ストレッチ＆散歩30分）
関節を休めろ。栄養・睡眠を優先。`;
  }
}

// ====== Push送信：テスト用エンドポイント ======
app.get('/push-test', async (_req, res) => {
  try {
    if (!LAST_USER_ID) return res.status(400).send('userId未取得。Botに一度話しかけて。');
    await client.pushMessage(LAST_USER_ID, {
      type: 'text',
      text: '【テストPush】起きろ。水500ml＋EAAを飲んでジムに行け。'
    });
    res.send('OK');
  } catch (e) {
    console.error('push error', e);
    res.status(500).send('NG');
  }
});

// ====== 定時リマインド（JST） ======
// 1日7回：05:50 / 06:05 / 07:20 / 12:00 / 15:00 / 20:00 / 22:30
// ngrok運用中はPC起動中のみ動く。本番はサーバ常時稼働に。
const TZ = 'Asia/Tokyo';
const schedules = [
  { cron: '50 5 * * *', text: '【起床】水500ml＋EAA。着替えたら即出発。言い訳は捨てろ。', tz: TZ },
  { cron: '5 6 * * *',  text: '【ジム前】動的ストレッチ→本日のメニュー実施。重量に逃げるな。', tz: TZ },
  { cron: '20 7 * * *', text: '【朝食】プロテイン→オートミール/おかゆローテで調理。写真を送れ。', tz: TZ },
  { cron: '0 12 * * *', text: '【昼】玄米150g＋刺身100〜150g（8〜12切れ）。食後20分歩け。', tz: TZ },
  { cron: '0 15 * * *', text: '【補食】プロテイン＋ナッツ10粒。軽HIIT or ストレッチ。', tz: TZ },
  { cron: '0 20 * * *', text: '【夕】鶏むね120g＋豆腐＋サラダ。ゆっくり噛め。水分チェック。', tz: TZ },
  { cron: '30 22 * * *', text: '【就寝前】ヨーグルト＋プロテイン。明朝準備。23:00で電源OFF。', tz: TZ },
];

for (const s of schedules) {
  cron.schedule(s.cron, async () => {
    try {
      if (!LAST_USER_ID) return; // まだ誰も話しかけていない
      await client.pushMessage(LAST_USER_ID, { type: 'text', text: s.text });
    } catch (err) {
      console.error('cron push error', err);
    }
  }, { timezone: s.tz });
}

// ---- Liveness ----
app.get('/', (_req, res) => res.send('OK'));
app.listen(process.env.PORT || 3000, () => console.log('Server OK'));
>>>>>>> 489c980 (Remove echo back of user message)
