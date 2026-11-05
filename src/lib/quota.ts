import type { SupabaseClient } from "@supabase/supabase-js";
import { config } from "./config";

const WINDOW_MS = 60 * 60 * 1000;

/**
 * 質問の「予約」。検索や回答生成（OpenAI / Claude の呼び出し）を始める前に呼ぶ。
 *  1. 先に質問の記録(query_logs)を作る  2. 直近1時間の自分の記録を数える  3. 上限を超えていれば記録を消して null を返す
 *
 * 回答の後に記録する方式だと、(a) 同時に大量の質問を送られると、全件が上限の手前を通り抜ける、
 * (b) 途中で失敗した質問が記録されず、失敗し続けても上限に達しない、という抜け穴ができる。
 * 先に記録を作れば、同時の質問も互いの記録を数えるので上限が効き、失敗した質問も数えられる。
 * 上限を超えた（断った）質問は費用がかからないので、記録を消して数えない。
 * 数えられなかったとき（DB の障害）は、作った記録を消して例外にする。
 */
export async function reserveQuery(
  db: SupabaseClient,
  input: { userId: string; channel: "slack" | "web"; question: string; nowMs?: number },
): Promise<number | null> {
  const { data, error } = await db
    .from("query_logs")
    .insert({ user_id: input.userId, channel: input.channel, question: input.question })
    .select("id")
    .single();
  if (error || !data) throw new Error(`質問の記録に失敗しました: ${error?.message ?? "不明"}`);
  const id = (data as { id: number }).id;

  const since = new Date((input.nowMs ?? Date.now()) - WINDOW_MS).toISOString();
  const counted = await db
    .from("query_logs")
    .select("id", { count: "exact", head: true })
    .eq("user_id", input.userId)
    .gte("created_at", since);
  if (counted.error) {
    await db.from("query_logs").delete().eq("id", id);
    throw new Error(`質問回数の確認に失敗しました: ${counted.error.message}`);
  }
  if ((counted.count ?? 0) > config.limits.questionsPerHour) {
    await db.from("query_logs").delete().eq("id", id);
    return null;
  }
  return id;
}

/** 予約した質問の記録に、回答・根拠チャンク・所要時間を書き足す */
export async function completeQuery(
  db: SupabaseClient,
  id: number,
  entry: { answer: string | null; sourceChunkIds: number[]; latencyMs: number },
): Promise<void> {
  const { error } = await db
    .from("query_logs")
    .update({ answer: entry.answer, source_chunk_ids: entry.sourceChunkIds, latency_ms: entry.latencyMs })
    .eq("id", id);
  if (error) throw new Error(`質問の記録の更新に失敗しました: ${error.message}`);
}
