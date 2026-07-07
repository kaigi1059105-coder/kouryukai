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
const COLUMN_COUNT = 12;
const HEADERS = [
  '月',
  '日時',
  '場所',
  '交流会名',
  'URL',
  '主催',
  '料金',
  'ステータス',
  '担当者',
  '通知済み',
  '目標リード',
  '目標アポ',
];

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
    slackMentionMap: parseMentionMap(props.getProperty('SLACK_MENTION_MAP')),
  };
}

function parseMentionMap(rawValue) {
  if (!rawValue) return {};

  try {
    return JSON.parse(rawValue);
  } catch (err) {
    console.error('SLACK_MENTION_MAP parse error:', err);
    return {};
  }
}

// ============================================================
// Slack Events API 受信
// ============================================================
function doPost(e) {
  const data = parseSlackRequest(e);

  if (data.type === 'url_verification') {
    return ContentService
      .createTextOutput(data.challenge || '')
      .setMimeType(ContentService.MimeType.TEXT);
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

function doGet() {
  return ContentService
    .createTextOutput('OK')
    .setMimeType(ContentService.MimeType.TEXT);
}

function parseSlackRequest(e) {
  const rawBody = e && e.postData && e.postData.contents ? e.postData.contents : '';
  if (rawBody) {
    try {
      return JSON.parse(rawBody);
    } catch (err) {
      console.error('JSON request parse failed:', err);
    }
  }

  if (e && e.parameter && e.parameter.payload) {
    try {
      return JSON.parse(e.parameter.payload);
    } catch (err) {
      console.error('Payload request parse failed:', err);
    }
  }

  return e && e.parameter ? e.parameter : {};
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
    const html = response.getContentText('UTF-8');
    const pageText = htmlToReadableText(html).substring(0, 20000);

    const extracted = extractEventInfo(pageText, url, config);
    if (!extracted) return;
    if (!hasExtractedEventInfo(extracted)) {
      console.error('No event info extracted for URL:', url);
      return;
    }

    addRowToSpreadsheet(extracted, url, config.spreadsheetId);
  } catch (err) {
    console.error('processEventUrl error:', err);
  }
}

function htmlToReadableText(html) {
  const source = String(html || '');
  const metadataText = extractMetadataText(source);
  const bodyText = source
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|h1|h2|h3|li|tr|table)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n\s*\n\s*\n/g, '\n\n')
    .replace(/[ \t]+/g, ' ')
    .trim();

  return (metadataText + '\n\n' + bodyText).trim();
}

function extractMetadataText(html) {
  const values = [];
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleMatch) values.push(titleMatch[1]);

  const metaRegex = /<meta\s+[^>]*(?:name|property)=["'](?:description|og:title|og:description|twitter:title|twitter:description)["'][^>]*content=["']([^"']*)["'][^>]*>/gi;
  let match;
  while ((match = metaRegex.exec(html)) !== null) {
    values.push(match[1]);
  }

  return values
    .map(function(value) {
      return value
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .trim();
    })
    .filter(function(value) {
      return value !== '';
    })
    .join('\n');
}

function extractEventInfo(pageText, url, config) {
  if (config.aiProvider === 'claude') {
    return extractEventInfoWithClaude(pageText, url, config);
  }
  return extractEventInfoWithGemini(pageText, url, config);
}

function buildExtractionPrompt(pageText, url) {
  return `
以下は交流会・イベントページから抽出した本文です。
URL: ${url}

この本文から交流会情報をJSON形式で抽出してください。
情報が見つからない項目は空文字("")にしてください。
JSON以外の説明文は返さないでください。

抽出項目:
- event_name: 交流会・イベント名
- date: 開催日時（例: 2026年7月15日（火）19:00〜21:00）
- month: 開催月（例: 7月）
- location: 開催場所・エリア（例: 銀座、新橋、オンライン）
- organizer: 主催者・運営会社名
- price: 参加料金（例: 無料、5000、5000（3000））

本文:
${pageText}
`;
}

function extractEventInfoWithGemini(pageText, url, config) {
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
        parts: [{ text: buildExtractionPrompt(pageText, url) }],
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

function extractEventInfoWithClaude(pageText, url, config) {
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
      messages: [{ role: 'user', content: buildExtractionPrompt(pageText, url) }],
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

function hasExtractedEventInfo(info) {
  return String(info.date || '').trim() !== '' &&
    String(info.event_name || '').trim() !== '';
}

function isUrlAlreadyRegistered(url, spreadsheetId) {
  const sheet = SpreadsheetApp.openById(spreadsheetId).getSheets()[0];
  ensureSheetHeaders(sheet);
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
  ensureSheetHeaders(sheet);
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
    '',
    '',
  ]);
  sortAndGroupRows(sheet);
}

function ensureSheetHeaders(sheet) {
  const existingHeaders = sheet.getRange(1, 1, 1, COLUMN_COUNT).getValues()[0];
  const needsUpdate = HEADERS.some(function(header, index) {
    return existingHeaders[index] !== header;
  });
  if (needsUpdate) {
    sheet.getRange(1, 1, 1, COLUMN_COUNT).setValues([HEADERS]);
  }
}

function sortAndGroupRows(sheet) {
  ensureSheetHeaders(sheet);

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return;

  const existingRows = sheet.getRange(2, 1, lastRow - 1, COLUMN_COUNT).getValues();
  const dataRows = existingRows.filter(function(row) {
    return row.some(function(value) {
      return String(value || '').trim() !== '';
    });
  });

  dataRows.sort(function(a, b) {
    return getDateSortKey(a[1], a[0]) - getDateSortKey(b[1], b[0]);
  });

  const outputRows = [];
  let previousMonth = '';
  dataRows.forEach(function(row) {
    const rowMonth = String(row[0] || getMonthFromDateText(row[1]) || '').trim();
    if (previousMonth && rowMonth && rowMonth !== previousMonth) {
      outputRows.push(new Array(COLUMN_COUNT).fill(''));
    }
    if (!row[0] && rowMonth) row[0] = rowMonth;
    outputRows.push(row);
    if (rowMonth) previousMonth = rowMonth;
  });

  sheet.getRange(2, 1, lastRow - 1, COLUMN_COUNT).clearContent();
  if (outputRows.length > 0) {
    sheet.getRange(2, 1, outputRows.length, COLUMN_COUNT).setValues(outputRows);
  }
}

function getDateSortKey(dateValue, monthValue) {
  if (Object.prototype.toString.call(dateValue) === '[object Date]' && !isNaN(dateValue.getTime())) {
    return dateValue.getTime();
  }

  const text = String(dateValue || '');
  const match = text.match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/);
  if (match) {
    return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])).getTime();
  }

  const monthMatch = String(monthValue || text).match(/(\d{1,2})月/);
  if (monthMatch) {
    return new Date(2099, Number(monthMatch[1]) - 1, 1).getTime();
  }

  return new Date(2999, 0, 1).getTime();
}

function getMonthFromDateText(dateValue) {
  const text = String(dateValue || '');
  const match = text.match(/(\d{1,2})月/);
  return match ? match[1] + '月' : '';
}

// ============================================================
// スプレッドシート編集検知、Slack通知
// ============================================================
function onEdit(e) {
  const sheet = e.source.getActiveSheet();
  const row = e.range.getRow();
  const col = e.range.getColumn();

  ensureSheetHeaders(sheet);

  if (row <= 1) return;
  if (isBlankDataRow(sheet, row)) return;

  const status = sheet.getRange(row, 8).getValue();
  if (isDeclinedStatus(status)) {
    sheet.deleteRow(row);
    sortAndGroupRows(sheet);
    return;
  }

  if (![2, 8, 9, 11, 12].includes(col)) {
    sortAndGroupRows(sheet);
    return;
  }

  const assignee = sheet.getRange(row, 9).getValue();
  const targetLead = sheet.getRange(row, 11).getValue();
  const targetAppointment = sheet.getRange(row, 12).getValue();
  if (!isReadyToNotify(status, assignee, targetLead, targetAppointment)) {
    sortAndGroupRows(sheet);
    return;
  }

  const notified = sheet.getRange(row, 10).getValue();
  if (notified === '通知済み') {
    sortAndGroupRows(sheet);
    return;
  }

  const eventName = sheet.getRange(row, 4).getValue();
  const date = sheet.getRange(row, 2).getValue();
  const location = sheet.getRange(row, 3).getValue();
  const url = sheet.getRange(row, 5).getValue();

  postSlackMessage(eventName, date, location, assignee, url, targetLead, targetAppointment);
  sheet.getRange(row, 10).setValue('通知済み');
  sortAndGroupRows(sheet);
}

function isBlankDataRow(sheet, row) {
  const values = sheet.getRange(row, 1, 1, COLUMN_COUNT).getValues()[0];
  return values.every(function(value) {
    return String(value || '').trim() === '';
  });
}

function isConfirmedStatus(status) {
  const normalized = String(status || '').trim();
  return normalized === '参加確定' || normalized === '行く';
}

function isDeclinedStatus(status) {
  const normalized = String(status || '').trim();
  return normalized === '不参加' || normalized === '行かない';
}

function isReadyToNotify(status, assignee, targetLead, targetAppointment) {
  return isConfirmedStatus(status) &&
    String(assignee || '').trim() !== '' &&
    String(targetLead || '').trim() !== '' &&
    String(targetAppointment || '').trim() !== '';
}

function formatAssigneeNames(assignee, mentionMap) {
  return String(assignee || '')
    .split(/[\/／、,，\s]+/)
    .map(function(name) {
      const trimmed = name.trim();
      if (!trimmed) return '';
      if (mentionMap && mentionMap[trimmed]) return mentionMap[trimmed];
      return /さん$|様$/.test(trimmed) ? trimmed : trimmed + 'さん';
    })
    .filter(function(name) {
      return name !== '';
    })
    .join('、');
}

function postSlackMessage(eventName, date, location, assignee, url, targetLead, targetAppointment) {
  const config = getConfig();
  const assigneeText = formatAssigneeNames(assignee, config.slackMentionMap);

  const messageText =
    date + '頃に' + assigneeText + '参加確定です！！\n\n' +
    '目標リード：' + targetLead + '件　目標アポ数：' + targetAppointment + '件\n' +
    '交流会参加後はこのスレッドに報告よろしくお願いいたします\n\n' +
    '交流会：' + eventName + '\n' +
    '場所：' + location + '\n' +
    'URL：' + url;

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
