// ============================================================
// 交流会管理 自動化システム
// ------------------------------------------------------------
// Slackに投稿されたイベントURLを読み取り、AIで交流会情報を抽出して
// Googleスプレッドシートに登録します。
// ============================================================

const QUEUE_PROPERTY_KEY = 'PENDING_EVENT_URLS';
const DEFAULT_AI_PROVIDER = 'gemini';
const DEFAULT_GEMINI_MODEL = 'gemini-3.1-flash-lite';
const DEFAULT_CLAUDE_MODEL = 'claude-sonnet-4-20250514';

function getConfig() {
  const props = PropertiesService.getScriptProperties();
  const aiProvider = (props.getProperty('AI_PROVIDER') || DEFAULT_AI_PROVIDER).toLowerCase();

  return {
    aiProvider: aiProvider,
    geminiApiKey: props.getProperty('GEMINI_API_KEY'),
    geminiModel: props.getProperty('GEMINI_MODEL') || DEFAULT_GEMINI_MODEL,
    claudeApiKey: props.getProperty('CLAUDE_API_KEY'),
    claudeModel: props.getProperty('CLAUDE_MODEL') || DEFAULT_CLAUDE_MODEL,
    slackBotToken: props.getProperty('SLACK_BOT_TOKEN'),
    slackNotifyChannel: props.getProperty('SLACK_NOTIFY_CHANNEL'),
    spreadsheetId: props.getProperty('SPREADSHEET_ID'),
    targetChannelId: props.getProperty('TARGET_CHANNEL_ID'),
  };
}

// ============================================================
// Slack Events API 受信
// ============================================================
function doPost(e) {
  const data = JSON.parse(e.postData.contents);

  if (data.type === 'url_verification') {
    return ContentService.createTextOutput(data.challenge);
  }

  if (data.event_id && isDuplicateEvent(data.event_id)) {
    return ContentService.createTextOutput('OK');
  }

  if (data.event && data.event.type === 'message' && !data.event.bot_id && !data.event.subtype) {
    const config = getConfig();
    const event = data.event;

    if (event.channel !== config.targetChannelId) {
      return ContentService.createTextOutput('OK');
    }

    const url = extractFirstUrl(event.text || '');
    if (url) {
      enqueueEventUrl({
        url: url,
        eventId: data.event_id || '',
        channel: event.channel,
        ts: event.ts || '',
        queuedAt: new Date().toISOString(),
      });
      scheduleQueueWorker();
    }
  }

  return ContentService.createTextOutput('OK');
}

function extractFirstUrl(text) {
  const match = text.match(/https?:\/\/[^\s>|]+/);
  if (!match) return '';
  return match[0].replace(/[),.。]+$/, '');
}

function isDuplicateEvent(eventId) {
  const cache = CacheService.getScriptCache();
  const key = 'slack_event_' + eventId;
  if (cache.get(key)) return true;
  cache.put(key, '1', 600);
  return false;
}

function enqueueEventUrl(item) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);

  try {
    const props = PropertiesService.getScriptProperties();
    const queue = JSON.parse(props.getProperty(QUEUE_PROPERTY_KEY) || '[]');

    const alreadyQueued = queue.some(function(queuedItem) {
      return queuedItem.url === item.url || (item.eventId && queuedItem.eventId === item.eventId);
    });
    if (!alreadyQueued) {
      queue.push(item);
      props.setProperty(QUEUE_PROPERTY_KEY, JSON.stringify(queue.slice(-50)));
    }
  } finally {
    lock.releaseLock();
  }
}

function scheduleQueueWorker() {
  const cache = CacheService.getScriptCache();
  if (cache.get('queue_worker_scheduled')) return;

  ScriptApp.newTrigger('processQueuedEventUrls')
    .timeBased()
    .after(1000)
    .create();

  cache.put('queue_worker_scheduled', '1', 60);
}

function processQueuedEventUrls() {
  removeCurrentQueueTriggers();

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);

  let queue = [];
  try {
    const props = PropertiesService.getScriptProperties();
    queue = JSON.parse(props.getProperty(QUEUE_PROPERTY_KEY) || '[]');
    props.deleteProperty(QUEUE_PROPERTY_KEY);
  } finally {
    lock.releaseLock();
  }

  if (queue.length === 0) return;

  const config = getConfig();
  queue.forEach(function(item) {
    processEventUrl(item.url, config);
  });
}

function removeCurrentQueueTriggers() {
  ScriptApp.getProjectTriggers().forEach(function(trigger) {
    if (trigger.getHandlerFunction() === 'processQueuedEventUrls') {
      ScriptApp.deleteTrigger(trigger);
    }
  });
}

// ============================================================
// URL取得、AI抽出、スプレッドシート登録
// ============================================================
function processEventUrl(url, config) {
  try {
    if (isUrlAlreadyRegistered(url, config.spreadsheetId)) return;

    const response = UrlFetchApp.fetch(url, {
      muteHttpExceptions: true,
      followRedirects: true,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; KouryukaiBot/1.0)',
      },
    });
    const html = response.getContentText('UTF-8').substring(0, 12000);

    const extracted = extractEventInfo(html, url, config);
    if (!extracted) return;

    addRowToSpreadsheet(extracted, url, config.spreadsheetId);
  } catch (err) {
    console.error('processEventUrl error:', err);
  }
}

function extractEventInfo(html, url, config) {
  if (config.aiProvider === 'claude') {
    return extractEventInfoWithClaude(html, url, config);
  }
  return extractEventInfoWithGemini(html, url, config);
}

function buildExtractionPrompt(html, url) {
  return `
以下は交流会・イベントページのHTMLです。
URL: ${url}

このHTMLから交流会情報をJSON形式で抽出してください。
情報が見つからない項目は空文字("")にしてください。
JSON以外の説明文は返さないでください。

抽出項目:
- event_name: 交流会・イベント名
- date: 開催日時（例: 2026年7月15日（火）19:00〜21:00）
- month: 開催月（例: 7月）
- location: 開催場所・エリア（例: 銀座、新橋、オンライン）
- organizer: 主催者・運営会社名
- price: 参加料金（例: 無料、5000、5000（3000））

HTML:
${html}
`;
}

function extractEventInfoWithGemini(html, url, config) {
  if (!config.geminiApiKey) {
    throw new Error('GEMINI_API_KEY is not set.');
  }

  const endpoint = 'https://generativelanguage.googleapis.com/v1beta/models/' +
    encodeURIComponent(config.geminiModel) + ':generateContent?key=' +
    encodeURIComponent(config.geminiApiKey);

  const response = UrlFetchApp.fetch(endpoint, {
    method: 'post',
    headers: {
      'Content-Type': 'application/json',
    },
    payload: JSON.stringify({
      contents: [{
        role: 'user',
        parts: [{ text: buildExtractionPrompt(html, url) }],
      }],
      generationConfig: {
        temperature: 0,
        responseMimeType: 'application/json',
      },
    }),
    muteHttpExceptions: true,
  });

  const statusCode = response.getResponseCode();
  const body = response.getContentText();
  if (statusCode < 200 || statusCode >= 300) {
    throw new Error('Gemini API error: ' + statusCode + ' ' + body);
  }

  const result = JSON.parse(body);
  const candidate = (result.candidates || [])[0] || {};
  const content = candidate.content || {};
  const part = (content.parts || [])[0] || {};
  const text = part.text || '';
  return parseJsonObject(text || '');
}

function extractEventInfoWithClaude(html, url, config) {
  if (!config.claudeApiKey) {
    throw new Error('CLAUDE_API_KEY is not set.');
  }

  const response = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': config.claudeApiKey,
      'anthropic-version': '2023-06-01',
    },
    payload: JSON.stringify({
      model: config.claudeModel,
      max_tokens: 512,
      messages: [{ role: 'user', content: buildExtractionPrompt(html, url) }],
    }),
    muteHttpExceptions: true,
  });

  const statusCode = response.getResponseCode();
  const body = response.getContentText();
  if (statusCode < 200 || statusCode >= 300) {
    throw new Error('Claude API error: ' + statusCode + ' ' + body);
  }

  const result = JSON.parse(body);
  const text = result.content[0].text.trim();
  return parseJsonObject(text);
}

function parseJsonObject(text) {
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    return JSON.parse(jsonMatch[0]);
  } catch (err) {
    console.error('JSON parse error:', text);
    return null;
  }
}

function isUrlAlreadyRegistered(url, spreadsheetId) {
  const sheet = SpreadsheetApp.openById(spreadsheetId).getSheets()[0];
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return false;

  const existingUrls = sheet.getRange(2, 5, lastRow - 1, 1).getValues();
  return existingUrls.some(function(row) {
    return row[0] === url;
  });
}

function addRowToSpreadsheet(info, url, spreadsheetId) {
  if (isUrlAlreadyRegistered(url, spreadsheetId)) return;

  const sheet = SpreadsheetApp.openById(spreadsheetId).getSheets()[0];
  sheet.appendRow([
    info.month || '',
    info.date || '',
    info.location || '',
    info.event_name || '',
    url,
    info.organizer || '',
    info.price || '',
    '検討中',
    '',
    '',
  ]);
}

// ============================================================
// スプレッドシート編集検知、Slack通知
// ============================================================
function onEdit(e) {
  const sheet = e.source.getActiveSheet();
  const row = e.range.getRow();
  const col = e.range.getColumn();

  if (row <= 1) return;
  if (col !== 8 && col !== 9) return;

  const status = sheet.getRange(row, 8).getValue();
  const assignee = sheet.getRange(row, 9).getValue();
  if (status !== '行く' || assignee === '') return;

  const notified = sheet.getRange(row, 10).getValue();
  if (notified === '通知済み') return;

  const eventName = sheet.getRange(row, 4).getValue();
  const date = sheet.getRange(row, 2).getValue();
  const location = sheet.getRange(row, 3).getValue();
  const url = sheet.getRange(row, 5).getValue();

  postSlackMessage(eventName, date, location, assignee, url);
  sheet.getRange(row, 10).setValue('通知済み');
}

function postSlackMessage(eventName, date, location, assignee, url) {
  const config = getConfig();

  const messageText =
    '✅ *【参加決定】*\n' +
    '*交流会名：* ' + eventName + '\n' +
    '*日時：* ' + date + '\n' +
    '*場所：* ' + location + '\n' +
    '*担当者：* ' + assignee + '\n' +
    '*URL：* ' + url + '\n\n' +
    '_このスレッドに参加後のメモや報告を残してください。_';

  const response = UrlFetchApp.fetch('https://slack.com/api/chat.postMessage', {
    method: 'post',
    headers: {
      'Content-Type': 'application/json; charset=UTF-8',
      'Authorization': 'Bearer ' + config.slackBotToken,
    },
    payload: JSON.stringify({
      channel: config.slackNotifyChannel,
      text: messageText,
      unfurl_links: false,
    }),
    muteHttpExceptions: true,
  });

  const result = JSON.parse(response.getContentText());
  if (!result.ok) {
    throw new Error('Slack API error: ' + response.getContentText());
  }
}
