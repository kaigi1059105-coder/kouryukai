# 交流会管理 自動化システム

Slackに営業が交流会URLを貼ると、AIがページを読んで交流会情報を抽出し、Googleスプレッドシートに自動登録します。スプレッドシートでステータス、担当者、目標リード、目標アポを入力すると、Slackに参加確定通知が届きます。

## 今回の構成

- Google Apps Script（`Code.gs`）
- Slack Events API
- Slack `chat.postMessage`
- Google Sheets
- Gemini API（既定。Claudeも任意で利用可）

Slack Events APIは3秒以内の応答が必要です。そのため、Slackからの受信時はURLをキューに入れてすぐ`OK`を返し、その後GASの一時トリガーでAI抽出とシート登録を実行します。

## スプレッドシート列

| 列 | 内容 |
|----|------|
| A | 月 |
| B | 日時 |
| C | 場所 |
| D | 交流会名 |
| E | URL |
| F | 主催 |
| G | 料金 |
| H | ステータス |
| I | 担当者 |
| J | 目標リード |
| K | 目標アポ |
| L | 通知を送る |
| M | 通知済み |
| N | リマインド済み |

1行目の見出しは次の通りです。

```text
月 / 日時 / 場所 / 交流会名 / URL / 主催 / 料金 / ステータス / 担当者 / 目標リード / 目標アポ / 通知を送る / 通知済み / リマインド済み
```

## スクリプトプロパティ

GASの「プロジェクトの設定」→「スクリプト プロパティ」に次を保存します。

| プロパティ名 | 値 |
|-------------|----|
| `SPREADSHEET_ID` | `1JjX5YYbrG3rZt2LotjHtk9LMuQn32nF0M955GQbS-Ds` |
| `SLACK_BOT_TOKEN` | SlackのBot User OAuth Token（`xoxb-...`） |
| `TARGET_CHANNEL_ID` | URL投稿を監視するチャンネルID。今回: `C0BCJTWJERW` |
| `SLACK_NOTIFY_CHANNEL` | 通知先チャンネルID。今回: `C0BCJTWJERW` |
| `AI_PROVIDER` | `gemini` |
| `GEMINI_API_KEY` | Google AI Studioで作成したAPIキー |
| `GEMINI_MODEL` | 省略可。既定は`gemini-3.1-flash-lite` |
| `SLACK_MENTION_MAP` | 任意。担当者名をSlackメンションに固定変換するJSON |

Claudeを使う場合だけ、`AI_PROVIDER=claude`、`CLAUDE_API_KEY`、必要なら`CLAUDE_MODEL`を設定します。

`SLACK_MENTION_MAP`の例:

```json
{"千石":"<@UXXXXXXXX>","長島":"<@UYYYYYYYY>"}
```

担当者欄に`千石/長島`と入れると、通知先チャンネル内のメンバーから苗字が一致する人を探してSlackメンションします。見つからない場合は`SLACK_MENTION_MAP`を使います。どちらも見つからない場合は`千石さん`のような通常テキストになります。

SlackユーザーIDは、Slackで対象メンバーのプロフィールを開き、「その他」→「メンバーIDをコピー」で取得します。

## Gemini APIキー取得

1. Google AI Studioを開く: https://aistudio.google.com/
2. 「Get API key」または「API keys」を開く
3. 新しいAPIキーを作成する
4. GASのスクリプトプロパティに`GEMINI_API_KEY`として保存する

無料枠の範囲で始めたい場合は、まずGeminiの無料枠で動作確認してください。利用量が増える場合はGoogle側の料金ページで最新の制限を確認します。

## Slack App設定

### OAuth Scopes

`bot-test` がプライベートチャンネルの場合は、通常のチャンネル用スコープだけではイベントを読めません。以下をBot Token Scopesに入れて、再インストールしてください。

- `chat:write`
- `channels:history`
- `channels:read`
- `groups:history`
- `groups:read`
- `users:read`

公開チャンネルだけなら`channels:*`で足りますが、今回の`bot-test`はプライベートとのことなので`groups:*`も入れるのが安全です。

`users:read`は、担当者名からSlackメンション対象を探すために必要です。追加後はSlack Appを再インストールしてください。

### Event Subscriptions

GASをWebアプリとしてデプロイしたあと、Slack AppのEvent Subscriptionsを設定します。

1. 「Event Subscriptions」を開く
2. 「Enable Events」をON
3. 「Request URL」にGASのWebアプリURLを貼る
4. 「Subscribe to bot events」に以下を追加
   - 公開チャンネル: `message.channels`
   - プライベートチャンネル: `message.groups`
5. 「Save Changes」

設定後、Slackの`bot-test`で次を実行します。

```text
/invite @交流会管理くん
```

## GASデプロイ

1. Googleスプレッドシートを開く
2. 「拡張機能」→「Apps Script」
3. `Code.gs`を貼り替えて保存
4. スクリプトプロパティを保存
5. 「デプロイ」→「新しいデプロイ」
6. 種類: 「ウェブアプリ」
7. 実行ユーザー: 「自分」
8. アクセスできるユーザー: 「全員」
9. デプロイURLをSlack Event SubscriptionsのRequest URLに貼る

初回実行時は、Google Sheets、UrlFetch、ScriptAppトリガーなどの権限許可が出ます。

## onEditトリガー

Slack通知には`UrlFetchApp`を使うため、シンプルトリガーではなくインストール型トリガーが必要です。

1. GASエディタ左メニューの「トリガー」
2. 「トリガーを追加」
3. 実行する関数: `onEdit`
4. イベントのソース: 「スプレッドシートから」
5. イベントの種類: 「編集時」
6. 保存

## 当日リマインド

当日の朝に参加予定をSlackへリマインドするには、GASで一度だけ次を実行します。

```text
setupDailyReminderTrigger
```

これで毎朝9時ごろに`sendTodayEventReminders`が動きます。対象はステータスが`参加確定`の行です。送信済みの日付はN列に入ります。

## 動作確認

1. `bot-test`に`/invite @交流会管理くん`を投稿
2. `bot-test`に交流会URLを1つ投稿
3. 1分程度待つ
4. スプレッドシートに1行追加されることを確認
5. H列を`参加確定`、I列に担当者名、J列に目標リード、K列に目標アポ、L列に`送る`を入力
6. Slackに参加決定通知が届くことを確認

## シート操作ルール

- URL登録後、行は日時順に自動で並び替えます。
- 月が変わる場所には空行を1行入れます。
- H列を`不参加`または`行かない`にすると、その行は自動削除されます。
- H列、L列などはプルダウンで選べます。
- 通知は`参加確定`、担当者、目標リード、目標アポ、`通知を送る=送る`が全部そろった時だけ送信されます。
- 通知後はM列に`通知済み`が入ります。
- 当日リマインド後はN列に日付が入ります。

## 重複対策

- Slackの`event_id`を10分間キャッシュし、再送イベントを無視します。
- シートのE列に同じURLがすでにある場合は、行を追加しません。
- キュー内でも同一URL・同一イベントIDを重複登録しません。
