// ============================================================
// 交流会管理 自動化システム
// ------------------------------------------------------------
// 営業がSlackにURLを貼る → AIが情報抽出 → スプレッドシートに登録
// ステータス「行く」＋担当者入力を検知 → Slackにスレッド付き通知
// ============================================================

// ============================================================
// 設定（スクリプトプロパティに保存する値）
// SLACK_BOT_TOKEN      : Slack BotのOAuthトークン (xoxb-...)
// SLACK_NOTIFY_CHANNEL : 通知を送るSlackチャンネルID
// CLAUDE_API_KEY       : Anthropic APIキー
// SPREADSHEET_ID       : 対象スプレッドシートのID
// TARGET_CHANNEL_ID    : URLを監視するSlackチャンネルID
// ============================================================
function getConfig() {
  const props = PropertiesService.getScriptProperties();
  return {
    slackBotToken:      props.getProperty('SLACK_BOT_TOKEN'),
    slackNotifyChannel: props.getProperty('SLACK_NOTIFY_CHANNEL'),
    claudeApiKey:       props.getProperty('CLAUDE_API_KEY'),
    spreadsheetId:      props.getProperty('SPREADSHEET_ID'),
    targetChannelId:    props.getProperty('TARGET_CHANNEL_ID'),
  };
}

// ============================================================
// ① Slackからのイベント受信（doPost）
// ============================================================
function doPost(e) {
  const data = JSON.parse(e.postData.contents);

  // Slack URL検証
  if (data.type === 'url_verification') {
    return ContentService.createTextOutput(data.challenge);
  }

  // Slackの再送イベントは無視（重複登録を防ぐ）
  // 3秒以内に応答できないとSlackが同じイベントを再送するため、event_idで排除する
  if (data.event_id && isDuplicateEvent(data.event_id)) {
    return ContentService.createTextOutput('OK');
  }

  // メッセージイベント
  if (data.event && data.event.type === 'message' && !data.event.bot_id) {
    const config = getConfig();
    const event = data.event;

    // 対象チャンネルのみ処理
    if (event.channel !== config.targetChannelId) {
      return ContentService.createTextOutput('OK');
    }

    const text = event.text || '';

    // URLが含まれているメッセージのみ処理
    const urlMatch = text.match(/https?:\/\/[^\s>]+/);
    if (urlMatch) {
      const url = urlMatch[0];
      processEventUrl(url, config);
    }
  }

  return ContentService.createTextOutput('OK');
}

// 同じSlackイベントを既に処理したかどうかを判定する（再送対策）
function isDuplicateEvent(eventId) {
  const cache = CacheService.getScriptCache();
  const key = 'slack_event_' + eventId;
  if (cache.get(key)) {
    return true; // 処理済み
  }
  cache.put(key, '1', 600); // 10分間記憶しておく
  return false;
}

// ============================================================
// ② URLからページを取得 → Claudeで情報抽出 → スプシに追加
// ============================================================
function processEventUrl(url, config) {
  try {
    const response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    const html = response.getContentText('UTF-8').substring(0, 8000);

    const extracted = extractEventInfoWithClaude(html, url, config.claudeApiKey);
    if (!extracted) return;

    addRowToSpreadsheet(extracted, url, config.spreadsheetId);
  } catch (err) {
    console.error('processEventUrl error:', err);
  }
}

function extractEventInfoWithClaude(html, url, apiKey) {
  const prompt = `
以下は交流会・イベントのページのHTMLです。
このHTMLから以下の情報をJSON形式で抽出してください。
情報が見つからない場合は空文字("")にしてください。

抽出する項目：
- event_name: 交流会・イベント名
- date: 開催日時（例：2026年7月15日（火）19:00〜21:00）
- month: 開催月（例：7月）
- location: 開催場所・エリア（例：銀座、新橋）
- organizer: 主催者・運営会社名
- price: 参加料金（数字のみ。会員価格がある場合は「5000（3000）」形式）

JSONのみ返してください。説明文は不要です。

HTML:
${html}
`;

  const response = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    payload: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 512,
      messages: [{ role: 'user', content: prompt }],
    }),
    muteHttpExceptions: true,
  });

  const result = JSON.parse(response.getContentText());
  const text = result.content[0].text.trim();

  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    return JSON.parse(jsonMatch[0]);
  } catch (err) {
    console.error('JSON parse error:', text);
    return null;
  }
}

function addRowToSpreadsheet(info, url, spreadsheetId) {
  const ss = SpreadsheetApp.openById(spreadsheetId);
  const sheet = ss.getSheets()[0];

  // 既に同じURLが登録済みなら追加しない（重複防止）
  const lastRow = sheet.getLastRow();
  if (lastRow >= 2) {
    const existingUrls = sheet.getRange(2, 5, lastRow - 1, 1).getValues(); // E列
    for (let i = 0; i < existingUrls.length; i++) {
      if (existingUrls[i][0] === url) return;
    }
  }

  sheet.appendRow([
    info.month        || '',  // A: 月
    info.date         || '',  // B: 日時
    info.location     || '',  // C: 場所
    info.event_name   || '',  // D: 交流会名
    url,                      // E: URL
    info.organizer    || '',  // F: 主催
    info.price        || '',  // G: 料金
    '検討中',                 // H: ステータス
    '',                       // I: 担当者
    '',                       // J: 通知済みフラグ
  ]);
}

// ============================================================
// ③ スプシ編集検知 → 「行く」＋担当者 → Slackにスレッド付き投稿
// ============================================================
function onEdit(e) {
  const sheet = e.source.getActiveSheet();
  const range = e.range;
  const row = range.getRow();
  const col = range.getColumn();

  // H列（8）またはI列（9）が編集されたとき
  if (col !== 8 && col !== 9) return;
  if (row <= 1) return; // ヘッダー行を除外

  const ステータス = sheet.getRange(row, 8).getValue();
  const 担当者     = sheet.getRange(row, 9).getValue();

  if (ステータス === '行く' && 担当者 !== '') {
    // 重複通知防止
    const notified = sheet.getRange(row, 10).getValue();
    if (notified === '通知済み') return;

    const 交流会名 = sheet.getRange(row, 4).getValue();
    const 日時     = sheet.getRange(row, 2).getValue();
    const 場所     = sheet.getRange(row, 3).getValue();

    postSlackMessage(交流会名, 日時, 場所, 担当者);
    sheet.getRange(row, 10).setValue('通知済み');
  }
}

// ============================================================
// Slack chat.postMessage で投稿（スレッド返信可能）
// ============================================================
function postSlackMessage(交流会名, 日時, 場所, 担当者) {
  const config = getConfig();

  const messageText =
    `✅ *【参加決定】*\n` +
    `*交流会名：* ${交流会名}\n` +
    `*日時：* ${日時}\n` +
    `*場所：* ${場所}\n` +
    `*担当者：* ${担当者}\n\n` +
    `_このスレッドに参加後のメモや報告を残してください 📝_`;

  UrlFetchApp.fetch('https://slack.com/api/chat.postMessage', {
    method: 'post',
    headers: {
      'Content-Type': 'application/json; charset=UTF-8',
      'Authorization': `Bearer ${config.slackBotToken}`,
    },
    payload: JSON.stringify({
      channel: config.slackNotifyChannel,
      text: messageText,
      // unfurl_links: false にすると URLプレビューを非表示にできる（お好みで）
    }),
  });
}
