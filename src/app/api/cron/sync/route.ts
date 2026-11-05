import { getAdminClient } from "@/lib/supabase";
import { isAuthorizedCron } from "@/lib/sync/cron-auth";
import { runSync } from "@/lib/sync/run";
import { createSyncSource, resolveSyncConfig } from "@/lib/sync/source";

// vercel.json の設定（300秒）と合わせる。処理の途中で打ち切られないよう、下の時間配分はこれより短くする
export const maxDuration = 300;

// 1回の実行で処理に使う時間。残りは、最後の1件の処理と結果の記録のための余裕
const WORK_BUDGET_MS = 240_000;

/**
 * 月次の同期の入口（Vercel Cron が GET で呼ぶ。スケジュールは vercel.json）。
 * 1回で終わらない量でも、進捗を保存して止まり、次の実行が続きから処理する。
 * 初回の全件取り込みは、結果の stoppedEarly が false になるまで手動で繰り返し呼ぶ。
 */
export async function GET(req: Request): Promise<Response> {
  if (!isAuthorizedCron(req.headers.get("authorization"), process.env.CRON_SECRET)) {
    return new Response("unauthorized", { status: 401 });
  }

  try {
    const config = resolveSyncConfig(process.env);
    const result = await runSync(getAdminClient(), createSyncSource(config), {
      cursorKey: config.cursorKey,
      maxDurationMs: WORK_BUDGET_MS,
    });
    // 失敗の詳細は ingestion_errors に記録済み。ここでは件数だけ返す
    return Response.json(result, { status: result.status === "error" ? 500 : 200 });
  } catch (e) {
    console.error("同期に失敗しました:", e);
    // 実行中の同期がある場合なども含め、内部の詳細は返さない
    return Response.json({ error: "sync failed" }, { status: 500 });
  }
}
