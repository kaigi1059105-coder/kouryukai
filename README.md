# 交流会管理 自動化システム

営業がSlackにURLを1つ貼るだけで、AIがそのページを読んで交流会情報をすべて抽出し、Googleスプレッドシートに自動登録します。参加決定時はSlackに自動通知し、そのスレッドを活動ログとして使えます。

## 全体フロー

```
営業がSlackに投稿
 └→「https://xxx.com/event/12345」（URLだけでOK）
        ↓ 自動
AIがURLのページを読み込み、以下を抽出：
 ・交流会名 / 日時（月も自動判定）/ 場所 / 主催 / 料金
        ↓ 自動
Googleスプレッドシートに1行追加
 ・ステータスは「検討中」で自動セット
 ・担当者は空欄
        ↓ マーケチームがスプシでステータスと担当者を入力
ステータス「行く」＋担当者入力を検知
        ↓ 自動
Slackに通知（chat.postMessage APIで投稿）：
「✅【参加決定】交流会名 / 日時 / 場所 / 担当者」
        ↓ その後
スレッドに自由に返信できる（活動ログ）
```

## スプレッドシートの列構成

| 列 | 内容 | 備考 |
|----|------|------|
| A | 月 | 例：6月 |
| B | 日時 | 例：2026年6月17日（水）19:00〜21:00 |
| C | 場所 | 例：銀座 |
| D | 交流会名 | 例：不動産ビジネス 90名 大交流会 in 銀座 |
| E | URL | 営業が投稿したURL |
| F | 主催 | 例：コンサルティングジャパン株式会社 |
| G | 料金 | 例：5000（会員価格は括弧書きで） |
| H | ステータス | 「行く」「行かない」「検討中」の3択 |
| I | 担当者 | 例：萩原さん（複数は「境さん/須藤さん」） |
| J | 通知済み | 自動でセットされる内部フラグ。触らない |

## 使う技術

- **Google Apps Script (GAS)**：全体の司令塔（`Code.gs`）
- **Slack API（Events API + chat.postMessage）**：URL受信 / スレッド付き通知送信
- **Claude API (Anthropic)**：URLページを読んで情報を抽出するAI
- **UrlFetchApp**：URLページのHTML取得

通知をスレッド返信可能にするため、Incoming Webhook ではなく Slack の `chat.postMessage` API を使用しています。

## セットアップ手順

### 1. Slack Appの作成

1. https://api.slack.com/apps にアクセス
2. 「Create New App」→「From scratch」
3. アプリ名（例：交流会Bot）とワークスペースを選択

**Bot Token Scopes**（「OAuth & Permissions」→「Scopes」→「Bot Token Scopes」）：

- `channels:history`
- `channels:read`
- `chat:write` ← スレッド付き投稿に必要

**アプリのインストール：** 「Install App」→「Install to Workspace」→ 許可 → 表示された「Bot User OAuth Token（xoxb-...）」をコピーして控える。

**Event Subscriptions**（GASデプロイ後に設定）：「Enable Events」をON →「Request URL」にGASのデプロイURLを入力 →「Subscribe to bot events」で `message.channels` を追加 →「Save Changes」。

**Botをチャンネルに招待：** Slackで対象チャンネルを開き `/invite @交流会Bot`。URLを受信するチャンネルと通知を送るチャンネルの両方に招待する。

### 2. GASのセットアップ

1. 対象のGoogleスプレッドシートを開く
2. 「拡張機能」→「Apps Script」
3. `Code.gs` の内容を貼り付けて保存

**スクリプトプロパティ**（「プロジェクトの設定（歯車）」→「スクリプト プロパティ」）：

| プロパティ名 | 値の取得場所 |
|-------------|-------------|
| SLACK_BOT_TOKEN | Slack App「OAuth & Permissions」のBot User OAuth Token |
| SLACK_NOTIFY_CHANNEL | 通知を送りたいチャンネルID |
| CLAUDE_API_KEY | https://console.anthropic.com でAPIキーを発行 |
| SPREADSHEET_ID | スプレッドシートURLの `/d/` と `/edit` の間の文字列 |
| TARGET_CHANNEL_ID | URLを投稿するチャンネルのID |

（チャンネルIDはチャンネル名を右クリック→「チャンネル詳細」→一番下で確認できます）

### 3. GASのデプロイ

1. 「デプロイ」→「新しいデプロイ」
2. 種類：「ウェブアプリ」
3. 実行ユーザー：「自分」
4. アクセスできるユーザー：「全員」
5. 「デプロイ」→ 表示されたURLをコピー → Slack AppのEvent SubscriptionsのRequest URLに貼る

### 4. onEditトリガーの設定

`onEdit` で `UrlFetchApp` を使うため、シンプルトリガーではなくインストール型トリガーが必要です。

1. GASエディタ左メニュー「トリガー（時計アイコン）」
2. 「トリガーを追加」
3. 実行する関数：`onEdit`
4. イベントのソース：「スプレッドシートから」
5. イベントの種類：「編集時」
6. 保存

### 5. 動作確認

- **機能①：** Slackの対象チャンネルに交流会URLを貼って送信 → 数秒後にスプレッドシートに1行追加されればOK
- **機能②：** スプレッドシートのH列を「行く」、I列に担当者名を入力 → Slackに参加決定通知が届き、スレッド返信できればOK

## 補足

- Botの投稿に「このスレッドにメモを残してください」の一文を添えるので、チームへの使い方の説明が不要になります。
- J列（通知済みフラグ）は自動でセットされます。削除しないでください。
- Claude APIの料金は1件あたり約0.01〜0.05円です。
- connpass・Peatix・こくちーずなど主要イベントサイトはHTML取得可能です。
