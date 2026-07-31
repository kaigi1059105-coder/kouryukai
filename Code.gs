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
const COLUMN_COUNT = 14;
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
  '目標リード',
  '目標アポ',
  '通知を送る',
  '通知済み',
  'リマインド済み',
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

    const url = extractFirstUrlFromSlackEvent(event);
    if (url) {
      enqueueEventUrl({
        url: url,
        slackContext: buildSlackEventContext(event),
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

function extractFirstUrlFromSlackEvent(event) {
  const candidates = [];
  collectSlackUrlCandidates(event, candidates);

  for (let i = 0; i < candidates.length; i++) {
    const url = extractFirstUrl(candidates[i]);
    if (url) return url;
  }

  return '';
}

function buildSlackEventContext(event) {
  const candidates = [];
  collectSlackUrlCandidates(event, candidates);
  return candidates
    .map(function(value) {
      return String(value || '').trim();
    })
    .filter(function(value) {
      return value !== '';
    })
    .slice(0, 30)
    .join('\n');
}

function collectSlackUrlCandidates(value, candidates) {
  if (value === null || value === undefined) return;

  if (typeof value === 'string') {
    candidates.push(value);
    return;
  }

  if (Array.isArray(value)) {
    value.forEach(function(item) {
      collectSlackUrlCandidates(item, candidates);
    });
    return;
  }

  if (typeof value !== 'object') return;

  ['url', 'original_url', 'from_url', 'title_link', 'text', 'fallback'].forEach(function(key) {
    if (value[key]) {
      collectSlackUrlCandidates(value[key], candidates);
    }
  });

  ['blocks', 'elements', 'attachments', 'fields', 'accessory'].forEach(function(key) {
    if (value[key]) {
      collectSlackUrlCandidates(value[key], candidates);
    }
  });
}

function extractFirstUrl(text) {
  const normalizedText = String(text || '');
  const protocolMatch = normalizedText.match(/https?:\/\/[^\s>|]+/);
  if (protocolMatch) return cleanExtractedUrl(protocolMatch[0]);

  const domainMatch = normalizedText.match(/\b(?:www\.)?[a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)+(?:\/[^\s>|]*)?/i);
  if (!domainMatch) return '';

  const candidate = domainMatch[0];
  if (isIgnoredDomainCandidate(candidate)) return '';

  return cleanExtractedUrl('https://' + candidate);
}

function cleanExtractedUrl(url) {
  return String(url || '')
    .replace(/[)\],.。]+$/, '');
}

function isIgnoredDomainCandidate(candidate) {
  const normalized = String(candidate || '').toLowerCase();
  return normalized === '' ||
    normalized.indexOf('@') !== -1 ||
    normalized.endsWith('.jpg') ||
    normalized.endsWith('.jpeg') ||
    normalized.endsWith('.png') ||
    normalized.endsWith('.gif') ||
    normalized.endsWith('.webp');
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
    processEventUrl(item.url, config, item);
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
function processEventUrl(url, config, slackItem) {
  try {
    if (isUrlAlreadyRegistered(url, config.spreadsheetId)) {
      postSlackThreadReply(config, slackItem, 'このURLはすでにスプシに登録済みです。');
      return;
    }

    const response = UrlFetchApp.fetch(url, {
      muteHttpExceptions: true,
      followRedirects: true,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; KouryukaiBot/1.0)',
      },
    });
    const html = response.getContentText('UTF-8');
    const pageText = htmlToReadableText(html).substring(0, 20000);
    const imageUrl = extractPrimaryImageUrl(html, url);
    const extractionText = [
      slackItem && slackItem.slackContext ? 'Slack投稿・リンク展開情報:\n' + slackItem.slackContext : '',
      'ページ本文:\n' + pageText,
    ].filter(function(value) {
      return value !== '';
    }).join('\n\n');

    const extracted = mergeWithFallbackEventInfo(
      extractEventInfo(extractionText, url, config, imageUrl),
      extractionText,
      url
    );
    if (!hasExtractedEventInfo(extracted)) {
      console.error('No event info extracted for URL:', url);
      postSlackThreadReply(config, slackItem, 'ページは開けましたが、日時と交流会名を自動で取れませんでした。手入力してください。');
      return;
    }

    addRowToSpreadsheet(extracted, url, config.spreadsheetId);
    postSlackThreadReply(config, slackItem, 'スプシに追加しました。');
  } catch (err) {
    console.error('processEventUrl error:', err);
    postSlackThreadReply(config, slackItem, '登録中にエラーが出ました。GASの実行数を確認してください。');
  }
}

function postSlackThreadReply(config, slackItem, text) {
  if (!slackItem || !slackItem.channel || !slackItem.ts) return;

  UrlFetchApp.fetch('https://slack.com/api/chat.postMessage', {
    method: 'post',
    headers: {
      'Content-Type': 'application/json; charset=UTF-8',
      'Authorization': 'Bearer ' + config.slackBotToken,
    },
    payload: JSON.stringify({
      channel: slackItem.channel,
      thread_ts: slackItem.ts,
      text: text,
      unfurl_links: false,
    }),
    muteHttpExceptions: true,
  });
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

function extractPrimaryImageUrl(html, pageUrl) {
  const source = String(html || '');
  const patterns = [
    /<meta\s+[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["'][^>]*>/i,
    /<meta\s+[^>]*name=["']twitter:image["'][^>]*content=["']([^"']+)["'][^>]*>/i,
    /<img\s+[^>]*(?:class|alt|title)=["'][^"']*(?:main|hero|event|交流会|セミナー)[^"']*["'][^>]*src=["']([^"']+)["'][^>]*>/i,
    /<img\s+[^>]*src=["']([^"']+)["'][^>]*>/i,
  ];

  for (let i = 0; i < patterns.length; i++) {
    const match = source.match(patterns[i]);
    if (match && match[1]) return resolveUrl(match[1], pageUrl);
  }

  return '';
}

function resolveUrl(rawUrl, baseUrl) {
  const value = String(rawUrl || '').trim();
  if (!value) return '';
  if (value.match(/^https?:\/\//i)) return value;
  if (value.indexOf('//') === 0) return 'https:' + value;

  const baseMatch = String(baseUrl || '').match(/^(https?:\/\/[^\/]+)(\/.*)?$/i);
  if (!baseMatch) return value;
  if (value.charAt(0) === '/') return baseMatch[1] + value;

  const basePath = (baseMatch[2] || '/').replace(/\/[^\/]*$/, '/');
  return baseMatch[1] + basePath + value;
}

function extractEventInfo(pageText, url, config, imageUrl) {
  if (config.aiProvider === 'claude') {
    return extractEventInfoWithClaude(pageText, url, config);
  }
  return extractEventInfoWithGemini(pageText, url, config, imageUrl);
}

function buildExtractionPrompt(pageText, url, hasImage) {
  return `
以下は交流会・イベントページから抽出した本文です。
URL: ${url}
${hasImage ? '添付画像にも日時・場所・交流会名・料金が書かれている可能性があります。画像内の文字も読んでください。' : ''}

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

function extractEventInfoWithGemini(pageText, url, config, imageUrl) {
  if (!config.geminiApiKey) {
    throw new Error('GEMINI_API_KEY is not set.');
  }

  const endpoint = 'https://generativelanguage.googleapis.com/v1beta/models/' +
    encodeURIComponent(config.geminiModel) + ':generateContent?key=' +
    encodeURIComponent(config.geminiApiKey);

  const parts = [{ text: buildExtractionPrompt(pageText, url, Boolean(imageUrl)) }];
  const imagePart = fetchGeminiImagePart(imageUrl);
  if (imagePart) parts.push(imagePart);

  const response = UrlFetchApp.fetch(endpoint, {
    method: 'post',
    headers: {
      'Content-Type': 'application/json',
    },
    payload: JSON.stringify({
      contents: [{
        role: 'user',
        parts: parts,
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

function fetchGeminiImagePart(imageUrl) {
  if (!imageUrl) return null;

  try {
    const response = UrlFetchApp.fetch(imageUrl, {
      muteHttpExceptions: true,
      followRedirects: true,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; KouryukaiBot/1.0)',
      },
    });
    const statusCode = response.getResponseCode();
    if (statusCode < 200 || statusCode >= 300) return null;

    const blob = response.getBlob();
    const contentType = blob.getContentType() || 'image/png';
    if (!contentType.match(/^image\//)) return null;

    return {
      inlineData: {
        mimeType: contentType,
        data: Utilities.base64Encode(blob.getBytes()),
      },
    };
  } catch (err) {
    console.error('Image fetch error:', err);
    return null;
  }
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
      messages: [{ role: 'user', content: buildExtractionPrompt(pageText, url, false) }],
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

function mergeWithFallbackEventInfo(aiInfo, pageText, url) {
  const fallbackInfo = extractEventInfoFallback(pageText, url);
  const result = {};
  ['month', 'date', 'location', 'event_name', 'organizer', 'price'].forEach(function(key) {
    result[key] = String((aiInfo && aiInfo[key]) || '').trim() ||
      String(fallbackInfo[key] || '').trim();
  });
  return result;
}

function extractEventInfoFallback(pageText, url) {
  const text = String(pageText || '');
  const lines = text
    .split(/\n+/)
    .map(function(line) {
      return line.trim();
    })
    .filter(function(line) {
      return line !== '';
    });

  const date = extractDateFallback(text);
  return {
    event_name: extractEventNameFallback(lines, url),
    date: date,
    month: getMonthFromDateText(date),
    location: extractLocationFallback(text),
    organizer: extractOrganizerFallback(text),
    price: extractPriceFallback(text),
  };
}

function extractEventNameFallback(lines, url) {
  for (let i = 0; i < Math.min(lines.length, 15); i++) {
    const line = lines[i]
      .replace(/\s*[-|]\s*こくちーずプロ.*$/i, '')
      .replace(/\s*[-|]\s*Peatix.*$/i, '')
      .replace(/\s*[-|]\s*connpass.*$/i, '')
      .trim();
    if (line.length >= 8 && !line.match(/^https?:\/\//) && line.indexOf('ログイン') === -1) {
      return line;
    }
  }

  return url;
}

function extractDateFallback(text) {
  const fullDateMatch = text.match(/20\d{2}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日[^\n]{0,40}(?:\d{1,2}[:：]\d{2}[^\n]{0,30})?/);
  if (fullDateMatch) return fullDateMatch[0].replace(/\s+/g, '');

  const shortDateMatch = text.match(/\d{1,2}\s*月\s*\d{1,2}\s*日[^\n]{0,40}(?:\d{1,2}[:：]\d{2}[^\n]{0,30})?/);
  if (shortDateMatch) return shortDateMatch[0].replace(/\s+/g, '');

  return '';
}

function extractLocationFallback(text) {
  const areaMatch = text.match(/[（(](東京都|大阪府|京都府|北海道|.{2,3}県)[）)]/);
  if (areaMatch) return areaMatch[1];

  const locationMatch = text.match(/(?:会場|場所|開催場所)[:：]\s*([^\n]+)/);
  return locationMatch ? locationMatch[1].trim() : '';
}

function extractOrganizerFallback(text) {
  const organizerMatch = text.match(/(?:主催|主催者|運営)[:：]\s*([^\n]+)/);
  return organizerMatch ? organizerMatch[1].trim() : '';
}

function extractPriceFallback(text) {
  if (text.match(/(?:参加費|料金|登録料|手数料)[^\n]{0,20}無料|無料[^\n]{0,20}(?:参加|登録料|手数料)/)) {
    return '無料';
  }

  const priceMatch = text.match(/(?:参加費|料金|会費)[^\n]{0,20}([0-9,]+)\s*円?/);
  return priceMatch ? priceMatch[1].replace(/,/g, '') : '';
}

function isUrlAlreadyRegistered(url, spreadsheetId) {
  const sheet = SpreadsheetApp.openById(spreadsheetId).getSheets()[0];
  ensureSheetHeaders(sheet);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return false;

  const targetUrl = canonicalizeUrlForCompare(url);
  const existingUrls = sheet.getRange(2, 5, lastRow - 1, 1).getValues();
  return existingUrls.some(function(row) {
    return canonicalizeUrlForCompare(row[0]) === targetUrl;
  });
}

function canonicalizeUrlForCompare(url) {
  return String(url || '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .replace(/\/+$/, '')
    .toLowerCase();
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
    '',
    '',
  ]);
  sortAndGroupRows(sheet);
}

function ensureSheetHeaders(sheet) {
  migrateOldColumnLayout(sheet);
  migrateReminderColumnLayout(sheet);

  const existingHeaders = sheet.getRange(1, 1, 1, COLUMN_COUNT).getValues()[0];
  const needsUpdate = HEADERS.some(function(header, index) {
    return existingHeaders[index] !== header;
  });
  if (needsUpdate) {
    sheet.getRange(1, 1, 1, COLUMN_COUNT).setValues([HEADERS]);
  }

  applySheetStyleAndValidation(sheet);
}

function migrateOldColumnLayout(sheet) {
  const oldHeaders = sheet.getRange(1, 1, 1, 12).getValues()[0];
  const isOldLayout = oldHeaders[9] === '通知済み' &&
    oldHeaders[10] === '目標リード' &&
    oldHeaders[11] === '目標アポ';

  if (!isOldLayout) return;

  const lastRow = Math.max(sheet.getLastRow(), 1);
  const oldRows = sheet.getRange(1, 1, lastRow, 12).getValues();
  const newRows = oldRows.map(function(row, index) {
    if (index === 0) return HEADERS.slice();

    return [
      row[0],
      row[1],
      row[2],
      row[3],
      row[4],
      row[5],
      row[6],
      row[7],
      row[8],
      row[10],
      row[11],
      '',
      row[9],
      '',
    ];
  });

  sheet.getRange(1, 1, lastRow, COLUMN_COUNT).setValues(newRows);
}

function migrateReminderColumnLayout(sheet) {
  const oldHeaders = sheet.getRange(1, 1, 1, 13).getValues()[0];
  const needsReminderColumn = oldHeaders[12] === '通知済み';
  if (!needsReminderColumn) return;

  const lastRow = Math.max(sheet.getLastRow(), 1);
  const oldRows = sheet.getRange(1, 1, lastRow, 13).getValues();
  const newRows = oldRows.map(function(row, index) {
    if (index === 0) return HEADERS.slice();
    return row.concat(['']);
  });

  sheet.getRange(1, 1, lastRow, COLUMN_COUNT).setValues(newRows);
}

function applySheetStyleAndValidation(sheet) {
  sheet.setFrozenRows(1);
  sheet.getRange(1, 1, 1, COLUMN_COUNT)
    .setBackground('#1f4e79')
    .setFontColor('#ffffff')
    .setFontWeight('bold');

  const maxRows = Math.max(sheet.getMaxRows() - 1, 1);
  sheet.getRange(2, 1, maxRows, 1).setBackground('#eaf3f8');
  sheet.getRange(2, 2, maxRows, 2).setBackground('#f7fbff');
  sheet.getRange(2, 4, maxRows, 3).setBackground('#ffffff');
  sheet.getRange(2, 7, maxRows, 1).setBackground('#fff7e6');
  sheet.getRange(2, 8, maxRows, 1).setBackground('#eaf7ea');
  sheet.getRange(2, 9, maxRows, 1).setBackground('#fff2cc');
  sheet.getRange(2, 10, maxRows, 2).setBackground('#f3e8ff');
  sheet.getRange(2, 12, maxRows, 1).setBackground('#ffecec');
  sheet.getRange(2, 13, maxRows, 1).setBackground('#eeeeee');
  sheet.getRange(2, 14, maxRows, 1).setBackground('#eeeeee');

  const monthRule = SpreadsheetApp.newDataValidation()
    .requireValueInList(['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'], true)
    .setAllowInvalid(true)
    .build();
  const statusRule = SpreadsheetApp.newDataValidation()
    .requireValueInList(['検討中', '参加確定', '不参加'], true)
    .setAllowInvalid(true)
    .build();
  const sendRule = SpreadsheetApp.newDataValidation()
    .requireValueInList(['送る', '送らない'], true)
    .setAllowInvalid(true)
    .build();

  sheet.getRange(2, 1, maxRows, 1).setDataValidation(monthRule);
  sheet.getRange(2, 8, maxRows, 1).setDataValidation(statusRule);
  sheet.getRange(2, 12, maxRows, 1).setDataValidation(sendRule);

  recreateSheetFilter(sheet);
}

function recreateSheetFilter(sheet) {
  const existingFilter = sheet.getFilter();
  if (existingFilter) {
    existingFilter.remove();
  }

  const filterRowCount = Math.max(sheet.getMaxRows(), 2);
  sheet.getRange(1, 1, filterRowCount, COLUMN_COUNT).createFilter();
}

function setupKouryukaiSheet() {
  const config = getConfig();
  const sheet = SpreadsheetApp.openById(config.spreadsheetId).getSheets()[0];
  ensureSheetHeaders(sheet);
  sortAndGroupRows(sheet);
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
  const eventDate = getEventDateObject(dateValue, monthValue);
  if (eventDate) return eventDate.getTime();
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

  if (![2, 8, 9, 10, 11, 12].includes(col)) {
    sortAndGroupRows(sheet);
    return;
  }

  const assignee = sheet.getRange(row, 9).getValue();
  const targetLead = sheet.getRange(row, 10).getValue();
  const targetAppointment = sheet.getRange(row, 11).getValue();
  const sendFlag = sheet.getRange(row, 12).getValue();
  if (!isReadyToNotify(status, assignee, targetLead, targetAppointment, sendFlag)) {
    sortAndGroupRows(sheet);
    return;
  }

  const notified = sheet.getRange(row, 13).getValue();
  if (notified === '通知済み') {
    sortAndGroupRows(sheet);
    return;
  }

  const eventName = sheet.getRange(row, 4).getValue();
  const date = sheet.getRange(row, 2).getValue();
  const location = sheet.getRange(row, 3).getValue();
  const url = sheet.getRange(row, 5).getValue();

  postSlackMessage(eventName, date, location, assignee, url, targetLead, targetAppointment);
  sheet.getRange(row, 13).setValue('通知済み');
  sortAndGroupRows(sheet);
}

function sendPendingNotifications() {
  const config = getConfig();
  const sheet = SpreadsheetApp.openById(config.spreadsheetId).getSheets()[0];
  ensureSheetHeaders(sheet);

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return;

  for (let row = 2; row <= lastRow; row++) {
    if (isBlankDataRow(sheet, row)) continue;

    const status = sheet.getRange(row, 8).getValue();
    const assignee = sheet.getRange(row, 9).getValue();
    const targetLead = sheet.getRange(row, 10).getValue();
    const targetAppointment = sheet.getRange(row, 11).getValue();
    const sendFlag = sheet.getRange(row, 12).getValue();
    const notified = sheet.getRange(row, 13).getValue();

    if (notified === '通知済み') continue;
    if (!isReadyToNotify(status, assignee, targetLead, targetAppointment, sendFlag)) continue;

    const eventName = sheet.getRange(row, 4).getValue();
    const date = sheet.getRange(row, 2).getValue();
    const location = sheet.getRange(row, 3).getValue();
    const url = sheet.getRange(row, 5).getValue();

    postSlackMessage(eventName, date, location, assignee, url, targetLead, targetAppointment);
    sheet.getRange(row, 13).setValue('通知済み');
  }

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

function isReadyToNotify(status, assignee, targetLead, targetAppointment, sendFlag) {
  return isConfirmedStatus(status) &&
    String(assignee || '').trim() !== '' &&
    String(targetLead || '').trim() !== '' &&
    String(targetAppointment || '').trim() !== '' &&
    String(sendFlag || '').trim() === '送る';
}

function formatAssigneeNames(assignee, mentionMap, config) {
  return String(assignee || '')
    .split(/[\/／、,，\s]+/)
    .map(function(name) {
      const trimmed = name.trim();
      if (!trimmed) return '';
      if (mentionMap && mentionMap[trimmed]) return mentionMap[trimmed];
      let channelMention = '';
      try {
        channelMention = findSlackMentionByName(trimmed, config);
      } catch (err) {
        console.error('Slack mention lookup error:', err);
      }
      if (channelMention) return channelMention;
      return /さん$|様$/.test(trimmed) ? trimmed : trimmed + 'さん';
    })
    .filter(function(name) {
      return name !== '';
    })
    .join('、');
}

function findSlackMentionByName(name, config) {
  const normalizedName = normalizePersonName(name);
  if (!normalizedName) return '';

  const cache = CacheService.getScriptCache();
  const cacheKey = 'slack_mention_' + config.slackNotifyChannel + '_' + normalizedName;
  const cachedMention = cache.get(cacheKey);
  if (cachedMention) return cachedMention;

  const members = fetchSlackChannelMemberIds(config);
  for (let i = 0; i < members.length; i++) {
    const user = fetchSlackUserInfo(config, members[i]);
    if (!user || user.deleted || user.is_bot) continue;

    const names = [
      user.name,
      user.real_name,
      user.profile && user.profile.real_name,
      user.profile && user.profile.display_name,
      user.profile && user.profile.real_name_normalized,
      user.profile && user.profile.display_name_normalized,
    ].filter(function(value) {
      return String(value || '').trim() !== '';
    });

    if (names.some(function(candidate) {
      return normalizePersonName(candidate).indexOf(normalizedName) !== -1;
    })) {
      const mention = '<@' + user.id + '>';
      cache.put(cacheKey, mention, 21600);
      return mention;
    }
  }

  return '';
}

function normalizePersonName(value) {
  return String(value || '')
    .replace(/[さん様君くん氏\s　]/g, '')
    .toLowerCase();
}

function fetchSlackChannelMemberIds(config) {
  const cache = CacheService.getScriptCache();
  const cacheKey = 'slack_channel_members_' + config.slackNotifyChannel;
  const cachedMembers = cache.get(cacheKey);
  if (cachedMembers) {
    try {
      return JSON.parse(cachedMembers);
    } catch (err) {
      console.error('Slack member cache parse error:', err);
    }
  }

  let cursor = '';
  let members = [];
  do {
    const endpoint = 'https://slack.com/api/conversations.members?channel=' +
      encodeURIComponent(config.slackNotifyChannel) +
      '&limit=200' +
      (cursor ? '&cursor=' + encodeURIComponent(cursor) : '');
    const result = callSlackApiGet(config, endpoint);
    if (!result.ok) {
      console.error('Slack conversations.members error:', JSON.stringify(result));
      return [];
    }

    members = members.concat(result.members || []);
    cursor = result.response_metadata && result.response_metadata.next_cursor ?
      result.response_metadata.next_cursor : '';
  } while (cursor);

  cache.put(cacheKey, JSON.stringify(members), 1800);
  return members;
}

function fetchSlackUserInfo(config, userId) {
  const cache = CacheService.getScriptCache();
  const cacheKey = 'slack_user_' + userId;
  const cachedUser = cache.get(cacheKey);
  if (cachedUser) {
    try {
      return JSON.parse(cachedUser);
    } catch (err) {
      console.error('Slack user cache parse error:', err);
    }
  }

  const endpoint = 'https://slack.com/api/users.info?user=' + encodeURIComponent(userId);
  const result = callSlackApiGet(config, endpoint);
  if (!result.ok) {
    console.error('Slack users.info error:', JSON.stringify(result));
    return null;
  }

  cache.put(cacheKey, JSON.stringify(result.user), 21600);
  return result.user;
}

function callSlackApiGet(config, endpoint) {
  const response = UrlFetchApp.fetch(endpoint, {
    method: 'get',
    headers: {
      'Authorization': 'Bearer ' + config.slackBotToken,
    },
    muteHttpExceptions: true,
  });

  try {
    return JSON.parse(response.getContentText());
  } catch (err) {
    return {
      ok: false,
      error: 'invalid_json',
      body: response.getContentText(),
    };
  }
}

function testSlackMentionLookup() {
  const config = getConfig();
  const testName = '千石';
  const detail = diagnoseSlackMentionLookup(testName, config);

  let text = '';
  if (detail.mention) {
    text = detail.mention + ' メンションテストです。これが青くなれば成功です。';
  } else {
    text =
      'メンション検索に失敗しました。\n' +
      detail.message + '\n\n' +
      '確認するもの：\n' +
      '1. Slack AppのBot Token Scopesに users:read が入っている\n' +
      '2. OAuth & Permissionsで Reinstall to Workspace を押している\n' +
      '3. GASの SLACK_BOT_TOKEN が再インストール後の最新 xoxb- になっている\n' +
      '4. SLACK_NOTIFY_CHANNEL が通知先チャンネルIDになっている';
  }

  const response = UrlFetchApp.fetch('https://slack.com/api/chat.postMessage', {
    method: 'post',
    headers: {
      'Content-Type': 'application/json; charset=UTF-8',
      'Authorization': 'Bearer ' + config.slackBotToken,
    },
    payload: JSON.stringify({
      channel: config.slackNotifyChannel,
      text: text,
      unfurl_links: false,
    }),
    muteHttpExceptions: true,
  });

  const result = JSON.parse(response.getContentText());
  if (!result.ok) {
    throw new Error('Slack API error: ' + response.getContentText());
  }
}

function diagnoseSlackMentionLookup(name, config) {
  const normalizedName = normalizePersonName(name);
  const membersResult = callSlackApiGet(config, 'https://slack.com/api/conversations.members?channel=' +
    encodeURIComponent(config.slackNotifyChannel) + '&limit=200');

  if (!membersResult.ok) {
    return {
      mention: '',
      message: 'conversations.members が失敗しました。\nSlackエラー：' + JSON.stringify(membersResult),
    };
  }

  const members = membersResult.members || [];
  if (members.length === 0) {
    return {
      mention: '',
      message: '通知先チャンネルのメンバーを取得できましたが、人数が0人でした。SLACK_NOTIFY_CHANNELを確認してください。',
    };
  }

  let firstUserError = '';
  let checkedNames = [];
  for (let i = 0; i < members.length; i++) {
    const userResult = callSlackApiGet(config, 'https://slack.com/api/users.info?user=' + encodeURIComponent(members[i]));
    if (!userResult.ok) {
      if (!firstUserError) firstUserError = JSON.stringify(userResult);
      continue;
    }

    const user = userResult.user;
    if (!user || user.deleted || user.is_bot) continue;

    const names = [
      user.name,
      user.real_name,
      user.profile && user.profile.real_name,
      user.profile && user.profile.display_name,
      user.profile && user.profile.real_name_normalized,
      user.profile && user.profile.display_name_normalized,
    ].filter(function(value) {
      return String(value || '').trim() !== '';
    });

    checkedNames = checkedNames.concat(names);
    if (names.some(function(candidate) {
      return normalizePersonName(candidate).indexOf(normalizedName) !== -1;
    })) {
      return {
        mention: '<@' + user.id + '>',
        message: '',
      };
    }
  }

  if (firstUserError) {
    return {
      mention: '',
      message: 'users.info が失敗しました。\nSlackエラー：' + firstUserError,
    };
  }

  const sampleNames = checkedNames.slice(0, 12).join(' / ');
  return {
    mention: '',
    message: 'チャンネルメンバーは読めましたが「' + name + '」に一致する表示名がありませんでした。\n読めた名前例：' + sampleNames,
  };
}

function postSlackMessage(eventName, date, location, assignee, url, targetLead, targetAppointment) {
  const config = getConfig();
  const assigneeText = formatAssigneeNames(assignee, config.slackMentionMap, config);

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

function sendTodayEventReminders() {
  const config = getConfig();
  const sheet = SpreadsheetApp.openById(config.spreadsheetId).getSheets()[0];
  ensureSheetHeaders(sheet);

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return;

  const todayKey = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  const rows = sheet.getRange(2, 1, lastRow - 1, COLUMN_COUNT).getValues();

  rows.forEach(function(row, index) {
    if (row.every(function(value) { return String(value || '').trim() === ''; })) return;

    const status = row[7];
    const assignee = row[8];
    const reminderSent = row[13];
    if (!isConfirmedStatus(status)) return;
    if (String(assignee || '').trim() === '') return;
    if (String(reminderSent || '').trim() === todayKey) return;

    const eventDate = getEventDateObject(row[1], row[0]);
    if (!eventDate) return;

    const eventDateKey = Utilities.formatDate(eventDate, Session.getScriptTimeZone(), 'yyyy-MM-dd');
    if (eventDateKey !== todayKey) return;

    postSlackReminderMessage(config, {
      month: row[0],
      date: row[1],
      location: row[2],
      eventName: row[3],
      url: row[4],
      assignee: assignee,
      targetLead: row[9],
      targetAppointment: row[10],
    });

    sheet.getRange(index + 2, 14).setValue(todayKey);
  });
}

function getEventDateObject(dateValue, monthValue) {
  if (Object.prototype.toString.call(dateValue) === '[object Date]' && !isNaN(dateValue.getTime())) {
    return dateValue;
  }

  const text = String(dateValue || '');
  let match = text.match(/(20\d{2})\D+(\d{1,2})\D+(\d{1,2})/);
  if (match) {
    return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  }

  match = text.match(/(\d{1,2})\s*[\/／]\s*(\d{1,2})/);
  if (match) {
    return new Date(new Date().getFullYear(), Number(match[1]) - 1, Number(match[2]));
  }

  match = text.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  if (match) {
    const year = new Date().getFullYear();
    return new Date(year, Number(match[1]) - 1, Number(match[2]));
  }

  const monthMatch = String(monthValue || '').match(/(\d{1,2})月/);
  const dayMatch = text.match(/(\d{1,2})\s*日/);
  if (monthMatch && dayMatch) {
    const year = new Date().getFullYear();
    return new Date(year, Number(monthMatch[1]) - 1, Number(dayMatch[1]));
  }

  if (monthMatch) {
    const year = new Date().getFullYear();
    return new Date(year, Number(monthMatch[1]) - 1, 1);
  }

  return null;
}

function postSlackReminderMessage(config, eventInfo) {
  const assigneeText = formatAssigneeNames(eventInfo.assignee, config.slackMentionMap, config);
  const messageText =
    '【本日参加リマインド】\n' +
    eventInfo.date + 'に' + assigneeText + '参加予定です！！\n\n' +
    '目標リード：' + (eventInfo.targetLead || '') + '件　目標アポ数：' + (eventInfo.targetAppointment || '') + '件\n' +
    '交流会参加後はこのスレッドに報告よろしくお願いいたします\n\n' +
    '交流会：' + eventInfo.eventName + '\n' +
    '場所：' + eventInfo.location + '\n' +
    'URL：' + eventInfo.url;

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
    throw new Error('Slack reminder API error: ' + response.getContentText());
  }
}

function setupDailyReminderTrigger() {
  ScriptApp.getProjectTriggers().forEach(function(trigger) {
    if (trigger.getHandlerFunction() === 'sendTodayEventReminders') {
      ScriptApp.deleteTrigger(trigger);
    }
  });

  ScriptApp.newTrigger('sendTodayEventReminders')
    .timeBased()
    .everyDays(1)
    .atHour(9)
    .create();
}
