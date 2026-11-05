# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project status

SharePoint 上の PDF/Word（約5,000件）を対象にした RAG ナレッジ検索 + Slack ボット（MVP）。**実装中**（GitHub 公開リポジトリ `iru-heartbeat/rag-knowledge-slack`。秘密情報は `.env.local` のみで Git に含めない）。

**実装済み（テスト全件緑・typecheck OK。SharePoint 実接続と Slack 実投稿は未確認）**
- 基盤: `src/lib/config.ts`（設定の集約）、`src/lib/supabase.ts`（service_role クライアント）。`supabase.ts` / `embed.ts` / `graph/client.ts` / `rag/answer.ts` / `slack/client.ts` などは `import "server-only"` 済み（テストでは `vitest.config.ts` が空スタブに差し替える）。
- 取り込み `src/lib/ingest/`: 部品（chunk / parse-docx / parse-pdf / department / metadata / embed / upsert ほか）と、1本につないだ `pipeline.ts`（`ingestDocument`）。
- 入手元 `src/lib/sources/`: 共通の窓口 `DocumentSource`（`types.ts`）とローカルフォルダ版（`local.ts`）。SharePoint 版は `src/lib/graph/client.ts`（Graph delta 取得・ダウンロード。`graphAsSource` で窓口に合わせる）。**Azure 環境が無く実接続は未確認**（個人アカウントではアプリ登録できない。要件定義書 Q-06）。
- 同期 `src/lib/sync/`: `run.ts`（`runSync`: 変更取得→取り込み→`ingestion_runs`/`ingestion_errors` 記録、カーソルを `sync_state` に保存、時間切れで途中停止）、`source.ts`（`SYNC_SOURCE=sharepoint|local` で入手元を選ぶ）、`cron-auth.ts`。入口は `src/app/api/cron/sync/route.ts`（`CRON_SECRET` 必須、`vercel.json` で月次）。
- RAG `src/lib/rag/`: `retrieve.ts`（質問→Embedding→`match_chunks`、類似度の下限 `config.search.minSimilarity`=0.4）、`answer.ts`（根拠のみで Claude が出典つき要約。根拠なしは Claude を呼ばず「見つかりません」。出典はモデルの文章ではなく DB の値から組み立てる）。
- Slack `src/lib/slack/` + `src/app/api/slack/events/route.ts`: 署名検証 → 即 ack → `after()` で非同期にスレッド返信。Slack ユーザー→部署は**メールアドレス一致**（`user.ts`。初回に `users.slack_user_id` へ紐づけ。迷ったら拒否）。
- 管理画面 `src/app/admin/`: Supabase Auth（メール+パスワード）でログイン、`users.is_admin` が true の人だけ入れる。ダッシュボード（同期・失敗・部署未判定の文書）、質問ログ（`/admin/logs`、`loadQueryLogs`。直近100件、質問者・経路・回答・根拠数・所要時間）、ユーザー/部署の管理。`src/lib/auth/session.ts` の `requireAdmin()` を**画面と Server Action の両方の入口**で呼ぶ（middleware は Cookie 更新のみ）。管理者の追加・解除は画面からできない（DB で直接行う）。
- DB: Supabase プロジェクト `rag-knowledge-slack`（`kcbsfhfmyxiwlmsselsh`、東京）に `supabase/migrations/0001〜0012` 適用済み。6部署登録済み。サンプルPDF 4件を取り込み済み。`users` は管理者1件のみ。保存は `upsert_document` / `save_user`（1トランザクション）、検索は `match_chunks`、部署未判定の一覧は `unassigned_documents`。
- 動作確認用スクリプト `scripts/`: `sync-local.ts`（ローカルフォルダを本物の DB に取り込む）、`try-search.ts`（生の類似度を表示）、`try-ask.ts`（検索→回答を通しで）。実行は `npx tsx --conditions=react-server --env-file=.env.local scripts/<名前>.ts`。

- Web 詳細検索 `src/app/search/` + `src/app/login/`: 一般社員が Supabase Auth でログインし、部署・客先・期間で絞り込む（`src/lib/web/`）。確認済みメールで `users.auth_user_id` に初回紐づけ。AI 要約は未実装（要件上は任意）。
- 質問回数の上限 `src/lib/quota.ts`: 外部 API を呼ぶ**前**に `reserveQuery` で `query_logs` に記録を作り、直近1時間で `config.limits.questionsPerHour`(60) を超えたら断る（Slack・Web 共通。失敗した質問も数える）。
- 同期の取りこぼし対策: やり直しても直らない失敗（`NoTextError` / `EmptyDocumentError` / `ParseError` / `PermanentSourceError`=Graph の404・410 / サイズ超過）はカーソルを進め、それ以外の失敗は最初に失敗したページでカーソルを止めて次回やり直す。同期の二重起動は DB の部分ユニークインデックス（0011）で防ぐ。

**受入テスト**: AC-04（6部署の権限分離）・AC-05（該当なしで創作しない）・AC-07（Web の部署・客先・日付の絞り込みと権限）は `src/acceptance/ac04-ac05.test.ts`、AC-06（同期での追加・更新・削除の反映。ローカルの一時フォルダ入手元、専用キーで既存データに触れない）は `src/acceptance/ac06.test.ts` で自動化済み（本物のDBに仮ユーザーを作って検証し、終了時に削除）。`npm test` ではスキップされ、`RUN_ACCEPTANCE=1 npx vitest run src/acceptance` で実行する。
**未実装**: 受入テストのうち AC-01〜03・08・全件投入。README は作成済み。**解決済み**: Slack の公開チャンネルでのメンションへの返信は `chat.postEphemeral`（質問者にだけ見える）で投稿する（コードレビュー #4。`handle.ts` の `ephemeralUserId`。DM は通常の投稿）。**確認が必要**: Supabase の Authentication 設定で「Confirm email」が必須・公開サインアップが無効であること（`email_confirmed_at` を信用して紐づけているため）。**要対応**: `.env.local` の `SLACK_BOT_TOKEN` が Slack に拒否される（`invalid_auth`。`xoxb-` で始まる Bot User OAuth Token を設定する）。本番では `CRON_SECRET` を Vercel の環境変数にも同じ値で設定する。初回の全件取り込みは1回で終わらないので、`stoppedEarly` が false になるまで `/api/cron/sync` を繰り返し呼ぶ。

**運用ルール**
- 取り込みの規則（部署・客先・日付の抽出、見出し判定、チャンク分割）を変えたら、`config.pipelineVersion` を +1 する。保存済み文書の版数と違えば、内容が同じでも次回の同期で再処理される（`isUnchanged`）。Embedding モデルを変えた場合、部署が判定できず誰にも見えない文書も同様に再処理される。
- 部署の判定は**全か無か**（`department.ts`）。併記の一部だけが登録名に一致しても権限は付けず、`unmatched` に残して管理者の確認に回す。権限の付けすぎを避けるため、曖昧なときは「誰にも見せない」側に倒す。

- 要件の正: `要件定義書.md`（スコープ外: 予算、Phase 2、PowerPoint/OCR、役職階層別権限、提案書ドラフト生成。これらは追加しない）
- 実装計画: `C:\Users\irunt\.claude\plans\serialized-gathering-planet.md`（承認済み。ステップ・ディレクトリ構成・検証方法を記載。先頭にコードレビュー修正計画、後半が全体計画）
- ドキュメントは日本語で書く
- 外部 API は Embedding に OpenAI、回答生成に Claude を使う（どちらも文書の本文を外部送信する。サンプルは架空文書だが、実運用では要確認＝要件定義書 Q-07）。

## 文書の書式（サンプル `テスト用PDF_元ファイル/` 4件より）

1行目タイトル、2行目に `部署: 戦略 / 客先: 地方銀行A / 作成: 2024年 / 機密度: 社外秘`、本文は `1. 見出し` 形式。部署・客先・日付は**文書冒頭の記載から正規表現で抽出**する（AI の推測は使わない。権限に直結するため）。部署が判定できなければ「誰にも見せない」＋失敗として記録。作成日は年月日が分かれば `doc_date`、無ければ年だけ `doc_year`。PDF の文字は NFKC 正規化する（部首文字「⼈」等が混ざるため）。

## 進め方のルール

- **実装は1機能ずつ行う**。1つ実装・確認が終わってから次へ進み、複数機能をまとめて実装しない。
- 本件は模擬課題案件のため、**機能を実装するたびに初心者にも分かる説明を付ける**。次を必ず含めること:
  - その機能が何のためのものか（業務上の目的、システム全体のどこに位置するか）
  - どんな技術を選んだか
  - なぜその技術を選んだか（代替案との違い・トレードオフ）
  - 専門用語（RLS、Embedding、チャンク、pgvector など）は初出時に平易に言い換える

- 「スクショ見て」と言われたら、**クリップボードの画像をファイルに保存してから Read で閲覧する**（Windows。PowerShell の `Get-Clipboard -Format Image` で取得し PNG として保存。保存先はスクラッチパッドなどプロジェクト外の一時ディレクトリ）。クリップボードに画像がなければその旨を伝える。

## Commands

`npm install` 済み:

- `npm run dev` / `npm run build` / `npm start` — Next.js
- `npm run typecheck` — `tsc --noEmit`
- `npm test` — Vitest（全件）。単一ファイル: `npx vitest run path/to/file.test.ts`、名前指定: `npx vitest run -t "テスト名"`
- lint は未設定
- 修正・機能追加は「テストを先に書いて赤を確認 → 実装 → 全件緑 + typecheck」の順で行っている。サンプルPDFを使うテストは `テスト用PDF_元ファイル/` が無ければ自動スキップされる。

DB の変更は `supabase/migrations/` にファイルを追加し、Supabase MCP の `apply_migration` で適用する（ファイルと適用内容を一致させる）。環境変数は `.env.example` を `.env.local` にコピーして設定する（`.gitignore` 済み。秘密鍵をチャットに貼らない）。

## Architecture（計画上の全体像）

```
SharePoint --(月次Cron /api/cron/sync)--> 取り込み(Vercel Functions)
  Graph delta取得 -> PDF/docx解析 -> セクション単位チャンク -> メタデータ抽出 -> Embedding -> upsert
        |
        v
Supabase (Postgres + pgvector + RLS)
        |
   +----+-----+
   v          v
Slack Bot   Web詳細検索
```

- スタック: Next.js 15 (App Router, TS) on Vercel / Supabase / Embedding は OpenAI `text-embedding-3-small`（1536次元）/ 要約は Claude API / SharePoint は Microsoft Graph（読み取り専用）。モデル名・チャンク長・top-k は `src/lib/config.ts` に外部化する計画。
- **アクセス制御が中核要件**。2層で担保する:
  1. テーブルの RLS（`documents`/`chunks` は `document_access` × `user_departments` で `authenticated` のみ参照可。他テーブルは service_role 専用）。
  2. `match_chunks()` は `security definer` で service_role 専用。呼び出し側が解決した `p_user_id`（`users.id`）の所属部署で明示的にフィルタする。Slack/Web どちらの検索もこの関数経由にし、権限フィルタをアプリ側で省略しないこと。
- 検索パスは Slack・Web 共通（質問 Embedding → `match_chunks` → 根拠チャンクのみで Claude が出典付き要約。根拠なしは「見つかりません」と返し推測しない。文書内の指示は無視させる＝プロンプトインジェクション対策）。
- Slack: 署名検証 → 3秒以内に ack → Vercel の `waitUntil`/`after` で非同期回答をスレッドへ投稿。Slack ユーザー ID → `users.slack_user_id` → 部署で権限解決。未登録ユーザーは検索せず案内を返す。
- 取り込みは冪等・再開可能にする（`documents.content_hash` で差分判定、`sync_state` に delta リンク、`ingestion_runs`/`ingestion_errors` に進捗と失敗を記録し、失敗しても他文書は継続）。Vercel の実行時間制限のため小バッチで分割実行する。スキャンのみの PDF（OCR 不可）は失敗として記録する。
- `chunks.embedding_model` を保持し、Embedding モデル変更時に再ベクトル化できるようにする。

## 未確定事項（実装前に確認）

`要件定義書.md` 10章の Q-01〜Q-10。特に影響大: 文書の「部署」「客先」「日付」の決定ルール（暫定: SharePoint のフォルダ構造・ファイル名）、Slack ユーザーと部署の紐づけ方法、Web の認証方式。
