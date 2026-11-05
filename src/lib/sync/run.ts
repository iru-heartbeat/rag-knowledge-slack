import type { SupabaseClient } from "@supabase/supabase-js";
import { config } from "../config";
import { EmptyDocumentError, ingestDocument, ParseError, type IngestResult, type SourceFile } from "../ingest/pipeline";
import { NoTextError } from "../ingest/parse-pdf";
import { PermanentSourceError, type DocumentSource, type SourceItem } from "../sources/types";

export type SyncOptions = {
  /** sync_state に「どこまで同期したか」を保存するキー（入手元ごとに分ける） */
  cursorKey: string;
  /** この時間を超えたら、次の1件に進まず止める（Vercel の実行時間制限対策）。既定は無制限 */
  maxDurationMs?: number;
  /** テストで差し替えられる外部依存 */
  /** これより大きいファイルは取り込まない（バイト）。既定は config.limits.maxFileBytes */
  maxFileBytes?: number;
  ingest?: (db: SupabaseClient, file: SourceFile) => Promise<IngestResult>;
  now?: () => number;
};

export type SyncResult = {
  runId: number;
  /** done=全件成功 / partial=失敗あり、または途中で止めた / error=変更の取得自体に失敗 */
  status: "done" | "partial" | "error";
  total: number;
  succeeded: number;
  failed: number;
  skipped: number;
  deleted: number;
  /** 時間切れで途中で止めた。次回の実行が続きから処理する */
  stoppedEarly: boolean;
};

// 「実行中」とみなす期間。1回の実行は最大300秒（Vercel の上限）なので、その倍の10分を過ぎた running は、
// 強制終了などで残った古い記録とみなして整理する（初回の手動の繰り返し実行が、長く拒否され続けないようにする）
const RUNNING_WINDOW_MS = 10 * 60 * 1000;
const MAX_ERROR_CHARS = 500;

/**
 * 入手元の変更を取り込む。
 *  - 前回の続き(カーソル)から、変更一覧を1ページずつ取る
 *  - 1件ずつ取り込み、失敗しても他の文書は続行する。結果は ingestion_runs / ingestion_errors に記録する
 *  - 削除された文書は status=deleted にして、検索対象から外す
 *
 * カーソルの進め方（取りこぼしを防ぐための要）:
 *  SharePoint の delta は、一度渡した変更を二度と返さない。失敗したファイルがあるページより先へ
 *  カーソルを進めると、そのファイルは永久に取り込まれない。そのため、やり直せば直る可能性のある失敗が
 *  あったら、最初に失敗したページの位置までしか保存しない。次回はそこから再開し、成功済みの文書は
 *  中身の指紋で素早く飛ばされる。やり直しても直らない失敗（スキャンのみの PDF、本文が空）は進める。
 */
export async function runSync(
  db: SupabaseClient,
  source: DocumentSource,
  opts: SyncOptions,
): Promise<SyncResult> {
  const ingest = opts.ingest ?? ((d, f) => ingestDocument(d, f));
  const now = opts.now ?? Date.now;
  const startedAt = now();
  const timeUp = () => opts.maxDurationMs !== undefined && now() - startedAt >= opts.maxDurationMs;

  const maxFileBytes = opts.maxFileBytes ?? config.limits.maxFileBytes;
  const runId = await createRun(db);
  const result: SyncResult = {
    runId,
    status: "done",
    total: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
    deleted: 0,
    stoppedEarly: false,
  };

  const fail = async (item: SourceItem, title: string | null, message: string) => {
    result.failed++;
    await recordError(db, runId, item.sharepointId, title, message);
  };

  try {
    let cursor = await loadCursor(db, opts.cursorKey);
    let holdCursor: { at: string | null } | undefined; // やり直しが必要な失敗が出た最初のページの位置

    for (;;) {
      let page;
      try {
        page = await source.fetchChanges(cursor);
      } catch (e) {
        result.status = "error";
        await recordError(db, runId, null, "(同期全体)", `変更の取得に失敗しました: ${messageOf(e)}`);
        return await finish(db, result);
      }

      const pageStart = cursor;
      for (const item of page.items) {
        if (timeUp()) {
          result.stoppedEarly = true;
          break;
        }
        result.total++;
        const outcome = await processItem(db, source, item, ingest, maxFileBytes);
        if (outcome.kind === "ok") {
          result.succeeded++;
          if (outcome.skipped) result.skipped++;
          if (outcome.deleted) result.deleted++;
        } else {
          await fail(item, outcome.title, outcome.message);
          if (outcome.retryable) holdCursor ??= { at: pageStart };
        }
      }

      if (result.stoppedEarly) {
        // このページは途中。同じページをもう一度取って、済んだ分は指紋で飛ばしながら続きをやる
        await saveCursor(db, opts.cursorKey, (holdCursor ?? { at: pageStart }).at);
        break;
      }

      if (page.nextCursor !== null) {
        cursor = page.nextCursor;
        if (!holdCursor) await saveCursor(db, opts.cursorKey, cursor);
        continue;
      }
      // 最後のページ
      if (holdCursor) await saveCursor(db, opts.cursorKey, holdCursor.at);
      else if (page.finalCursor !== null) await saveCursor(db, opts.cursorKey, page.finalCursor);
      break;
    }

    result.status = result.failed > 0 || result.stoppedEarly ? "partial" : "done";
    return await finish(db, result);
  } catch (e) {
    // 想定外（DB の障害など）。実行中のまま残さず error として閉じてから、呼び出し側にも伝える
    result.status = "error";
    await recordError(db, runId, null, "(同期全体)", messageOf(e));
    await finish(db, result);
    throw e;
  }
}

type Outcome =
  | { kind: "ok"; skipped?: boolean; deleted?: boolean }
  | { kind: "failed"; title: string | null; message: string; retryable: boolean };

async function processItem(
  db: SupabaseClient,
  source: DocumentSource,
  item: SourceItem,
  ingest: NonNullable<SyncOptions["ingest"]>,
  maxFileBytes: number,
): Promise<Outcome> {
  if (item.kind === "deleted") {
    const { error } = await db
      .from("documents")
      .update({ status: "deleted", synced_at: new Date().toISOString() })
      .eq("sharepoint_id", item.sharepointId);
    return error
      ? { kind: "failed", title: null, message: `削除の反映に失敗しました: ${error.message}`, retryable: true }
      : { kind: "ok", deleted: true };
  }

  // 大きすぎるファイルは、メモリに載せる前に断る（関数が落ちると同期ごと止まるため）。やり直しても直らない
  const tooLarge = (bytes: number): Outcome => ({
    kind: "failed",
    title: item.title,
    message: `ファイルが大きすぎるため取り込めません（${Math.round(bytes / 1024 / 1024)}MB。上限 ${Math.round(maxFileBytes / 1024 / 1024)}MB）`,
    retryable: false,
  });
  if (item.size && item.size > maxFileBytes) return tooLarge(item.size);

  try {
    const buffer = await source.download(item.sharepointId);
    if (buffer.length > maxFileBytes) return tooLarge(buffer.length); // 事前のサイズが分からなかった場合の保険
    const r = await ingest(db, {
      sharepointId: item.sharepointId,
      title: item.title,
      url: item.url,
      fileType: item.fileType,
      buffer,
    });
    if (r.status === "skipped") return { kind: "ok", skipped: true };
    if (r.unassigned) {
      // 保存はされているが、誰にも見えない状態。権限に関わるので管理者の確認に回す（やり直しでは直らない）
      const unmatched = r.unmatchedDepartments.length > 0 ? `（記載: ${r.unmatchedDepartments.join(", ")}）` : "";
      return {
        kind: "failed",
        title: item.title,
        message: `部署を判定できません${unmatched}。誰にも見えない状態で保存しました`,
        retryable: false,
      };
    }
    return { kind: "ok" };
  } catch (e) {
    const permanent = e instanceof NoTextError || e instanceof EmptyDocumentError || e instanceof ParseError ||
      e instanceof PermanentSourceError;
    return { kind: "failed", title: item.title, message: messageOf(e), retryable: !permanent };
  }
}

// ===== 記録・状態の保存 =====

/**
 * 同期の記録(run)を作る。同時に動かせるのは1つだけ。
 * 「実行中の同期があるか確認してから作る」だと、ほぼ同時の2つが両方通ってしまう。
 * そこで DB 側に「running は1件まで」の制約（部分ユニークインデックス）を置き、作成そのものを排他にしている。
 * クラッシュして running のまま残った古い記録は、先に error に変えて、永遠に止まらないようにする。
 */
async function createRun(db: SupabaseClient): Promise<number> {
  const cutoff = new Date(Date.now() - RUNNING_WINDOW_MS).toISOString();
  const swept = await db
    .from("ingestion_runs")
    .update({ status: "error", finished_at: new Date().toISOString() })
    .eq("status", "running")
    .lt("started_at", cutoff);
  if (swept.error) throw new Error(`古い同期の記録の整理に失敗しました: ${swept.error.message}`);

  const { data, error } = await db.from("ingestion_runs").insert({}).select("id").single();
  if (error?.code === "23505") throw new Error("同期がすでに実行中です。終わってからもう一度実行してください");
  if (error || !data) throw new Error(`同期の記録を作れませんでした: ${error?.message ?? "不明"}`);
  return (data as { id: number }).id;
}

async function finish(db: SupabaseClient, r: SyncResult): Promise<SyncResult> {
  const { error } = await db
    .from("ingestion_runs")
    .update({
      finished_at: new Date().toISOString(),
      total: r.total,
      succeeded: r.succeeded,
      failed: r.failed,
      status: r.status,
    })
    .eq("id", r.runId);
  if (error) throw new Error(`同期結果の記録に失敗しました: ${error.message}`);
  return r;
}

async function recordError(
  db: SupabaseClient,
  runId: number,
  sharepointId: string | null,
  title: string | null,
  message: string,
): Promise<void> {
  const { error } = await db.from("ingestion_errors").insert({
    run_id: runId,
    sharepoint_id: sharepointId,
    title,
    error_message: message.slice(0, MAX_ERROR_CHARS),
  });
  // 記録の失敗で同期全体を止めない（他の文書の取り込みを優先する）
  if (error) console.error(`失敗の記録に失敗しました: ${error.message}`);
}

async function loadCursor(db: SupabaseClient, key: string): Promise<string | null> {
  const { data, error } = await db.from("sync_state").select("value").eq("key", key).maybeSingle();
  if (error) throw new Error(`同期の進捗の取得に失敗しました: ${error.message}`);
  return (data as { value: string | null } | null)?.value ?? null;
}

async function saveCursor(db: SupabaseClient, key: string, value: string | null): Promise<void> {
  const { error } = await db.from("sync_state").upsert({ key, value, updated_at: new Date().toISOString() });
  if (error) throw new Error(`同期の進捗の保存に失敗しました: ${error.message}`);
}

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));
