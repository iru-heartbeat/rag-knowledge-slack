# RAG ナレッジ検索 + Slack ボット

SharePoint 上の PDF / Word（約 5,000 件）を検索し、Slack で質問すると出典つきの要約を返すボットです。Web 画面からの詳細検索と、管理者向けの管理画面もあります。要件は `要件定義書.md` を参照してください。

> **状態**: MVP 完成。Vercel に本番デプロイ済みで、Slack（DM・チャンネル）、管理画面、Web 検索を実機で確認済みです。
> **SharePoint の実接続だけが未確認**です（個人アカウントでは Azure のアプリ登録ができないため。要件定義書 Q-06）。
> 取り込みは `src/lib/graph/client.ts`（SharePoint 版、モックでのテストのみ）と、`src/lib/sources/local.ts`（ローカルフォルダ版、実 DB で確認済み）の2通りの入手元に対応しており、同期の本体（`runSync`）は共通です。
> 受入テスト AC-01（5,000件の取り込み）と AC-03（出典リンクから SharePoint の元文書へ遷移）は、SharePoint 接続後に確認します。

## 何ができるか

| 機能 | 概要 |
|---|---|
| 取り込み | 文書を読み取り、段落ごとに分割（チャンク）して数値ベクトル（Embedding）にし、DB に保存する |
| Slack ボット | `@knowledge ◯◯について` で質問すると、スレッドに出典つき要約を返す |
| Web 詳細検索 | `/search`。部署・客先・期間で絞り込む |
| 管理画面 | `/admin`。同期結果、失敗した文書、部署未判定の文書、質問ログ（`/admin/logs`）、ユーザー・部署を管理する |

**アクセス制御が中核です。** 検索結果は、質問者の所属部署が閲覧できる文書だけに限られます。部署が判定できない文書は誰にも見せません。

## 構成

```
SharePoint --(月次 Cron /api/cron/sync)--> 取り込み
  変更取得 -> PDF/docx 解析 -> チャンク分割 -> メタデータ抽出 -> Embedding -> 保存
        |
        v
Supabase (Postgres + pgvector + RLS)
        |
   +----+-----+
   v          v
Slack Bot   Web 詳細検索
```

- Next.js 15 (App Router, TypeScript) / Vercel
- Supabase（Postgres, pgvector, Auth）
- Embedding: OpenAI `text-embedding-3-small`、要約: Claude
- SharePoint: Microsoft Graph（読み取り専用）

主なディレクトリ:

- `src/lib/ingest/` 取り込み部品とパイプライン
- `src/lib/sources/` 入手元の窓口（ローカルフォルダ版）、`src/lib/graph/` SharePoint 版
- `src/lib/sync/` 同期の実行・記録・再開
- `src/lib/rag/` 検索と回答生成
- `src/lib/slack/`、`src/app/api/slack/events/` Slack 連携
- `src/app/admin/`、`src/app/search/`、`src/app/login/` 画面
- `supabase/migrations/` DB の変更履歴
- `scripts/` 動作確認用スクリプト

## セットアップ

```bash
npm install
cp .env.example .env.local   # 値を設定する（秘密鍵をチャットや Git に載せない）
```

### 環境変数

| 変数 | 用途 |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase 接続（ブラウザ可） |
| `SUPABASE_SERVICE_ROLE_KEY` | サーバー専用。クライアントに出さない |
| `SLACK_SIGNING_SECRET` | Slack からのリクエストの署名検証 |
| `SLACK_BOT_TOKEN` | **`xoxb-` で始まる** Bot User OAuth Token |
| `ANTHROPIC_API_KEY` / `CLAUDE_MODEL` | 回答生成 |
| `OPENAI_API_KEY` / `EMBEDDING_MODEL` | Embedding |
| `AZURE_TENANT_ID` / `AZURE_CLIENT_ID` / `AZURE_CLIENT_SECRET` / `SHAREPOINT_DRIVE_ID` | SharePoint（Graph） |
| `CRON_SECRET` | `/api/cron/sync` の認証。Vercel にも同じ値を設定する |
| `SYNC_SOURCE` | `sharepoint`（既定）または `local` |
| `LOCAL_SOURCE_DIR` | `SYNC_SOURCE=local` のときの取り込み元フォルダ |

### Slack アプリの設定

- Bot Token Scopes: `app_mentions:read`, `chat:write`, `users:read`, `users:read.email`（DM を使うなら `im:history`）
- Event Subscriptions の Request URL: `https://<ドメイン>/api/slack/events`、購読イベント `app_mention`
- ユーザーと部署の紐づけは **メールアドレス一致**。登録の無い人には検索せず案内を返す

### Supabase の設定

- `supabase/migrations/` を順に適用する（0001〜0012）
- Authentication で **「Confirm email」を必須**にし、**公開サインアップを無効**にする（確認済みメールを信用して利用者を紐づけているため）
- 管理者の追加・解除は画面からできない。`users.is_admin` を DB で直接更新する

## 開発コマンド

```bash
npm run dev         # 開発サーバー
npm run build       # ビルド
npm run typecheck   # 型チェック
npm test            # 全テスト（Vitest）
npx vitest run path/to/file.test.ts   # 単一ファイル
```

サンプル PDF を使うテストは `テスト用PDF_元ファイル/` が無いと自動でスキップされます。

### 動作確認用スクリプト

```bash
npx tsx --conditions=react-server --env-file=.env.local scripts/<名前>.ts
```

- `sync-local.ts` ローカルフォルダを本物の DB に取り込む
- `try-search.ts` 生の類似度を表示する
- `try-ask.ts` 検索から回答までを通しで確認する

## 同期（取り込み）

- 入口は `GET /api/cron/sync`（`Authorization: Bearer <CRON_SECRET>` が必須）。`vercel.json` で月次実行
- 実行時間の制限があるため、時間切れで途中停止し、次回に続きから再開する
- **初回の全件取り込みは 1 回で終わりません。** 応答の `stoppedEarly` が `false` になるまで繰り返し呼ぶ
- 失敗は `ingestion_errors` に記録され、管理画面で確認できる。やり直しても直らない失敗は飛ばし、一時的な失敗は次回やり直す
- 二重起動は DB 側で防ぐ

### 取り込みの規則を変えたとき

部署・客先・日付の抽出、見出し判定、チャンク分割の規則を変えたら、`src/lib/config.ts` の `pipelineVersion` を +1 します。版数が違う文書は、内容が同じでも次回の同期で再処理されます。

## 文書の書式

1 行目がタイトル、2 行目に `部署: 戦略 / 客先: 地方銀行A / 作成: 2024年 / 機密度: 社外秘`、本文は `1. 見出し` 形式。部署・客先・日付は**文書冒頭の記載から正規表現で抽出**します（権限に直結するため AI の推測は使いません）。部署が判定できない文書は誰にも見せず、失敗として記録します。

## 外部送信について

Embedding（OpenAI）と回答生成（Claude）に、文書の本文が送信されます。サンプルは架空文書ですが、実運用の前に要件定義書 Q-07 で扱いを確認してください。

## 未実装・未決

- AC-01（5,000件の取り込み）・AC-03（SharePoint 元文書への遷移）: SharePoint 接続後に確認
- （対応済み）Slack の公開チャンネルでの返信は `chat.postEphemeral` で質問者にだけ見せる。DM は通常の投稿。ただし本人以外には見えず、履歴も残らない
