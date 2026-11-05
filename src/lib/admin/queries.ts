import type { SupabaseClient } from "@supabase/supabase-js";

export type AdminUser = { userId: string; email: string | null };

export type RunRow = {
  id: number;
  started_at: string;
  finished_at: string | null;
  status: "running" | "partial" | "done" | "error";
  total: number | null;
  succeeded: number | null;
  failed: number | null;
};

export type ErrorRow = {
  id: number;
  run_id: number;
  sharepoint_id: string | null;
  title: string | null;
  error_message: string | null;
  created_at: string;
};

export type UnassignedDoc = {
  id: string;
  title: string;
  url: string;
  customer: string | null;
  doc_year: number | null;
  synced_at: string;
};

/** 管理画面に出す質問ログ1件 */
export type QueryLogEntry = {
  id: number;
  createdAt: string;
  channel: "slack" | "web";
  question: string;
  /** 回答。null は、回答を書き足す前に処理が失敗した質問（Web 検索は回答文を持たないので常に null） */
  answer: string | null;
  /** 根拠にしたチャンクの数 */
  sourceCount: number;
  latencyMs: number | null;
  /** 質問者の表示名（無ければメール。利用者が削除されていれば「(削除済み)」） */
  userLabel: string;
};

export type Dashboard ={ runs: RunRow[]; errors: ErrorRow[]; unassigned: UnassignedDoc[] };

/**
 * ログインした人（Supabase Auth のユーザーID）が管理者か確かめる。
 * auth_user_id の一致と is_admin=true の両方を満たす users の行がある場合だけ管理者とする。
 * 該当が無ければ null（=管理者ではない）。DB のエラーは握りつぶさず例外にする。
 */
export async function findAdminUser(db: SupabaseClient, authUserId: string): Promise<AdminUser | null> {
  const { data, error } = await db
    .from("users")
    .select("id, email")
    .eq("auth_user_id", authUserId)
    .eq("is_admin", true)
    .maybeSingle();
  if (error) throw new Error(`管理者の確認に失敗しました: ${error.message}`);
  if (!data) return null;
  const row = data as { id: string; email: string | null };
  return { userId: row.id, email: row.email };
}

/** ダッシュボードに出す情報（最近の同期、取り込みの失敗、部署が判定できず誰にも見えない文書） */
export async function loadDashboard(db: SupabaseClient): Promise<Dashboard> {
  const [runs, errors, unassigned] = await Promise.all([
    db
      .from("ingestion_runs")
      .select("id, started_at, finished_at, status, total, succeeded, failed")
      .order("started_at", { ascending: false })
      .limit(10),
    db
      .from("ingestion_errors")
      .select("id, run_id, sharepoint_id, title, error_message, created_at")
      .order("created_at", { ascending: false })
      .limit(50),
    db.rpc("unassigned_documents", { p_limit: 100 }),
  ]);

  for (const r of [runs, errors, unassigned]) {
    if (r.error) throw new Error(`ダッシュボードの取得に失敗しました: ${r.error.message}`);
  }
  return {
    runs: (runs.data ?? []) as RunRow[],
    errors: (errors.data ?? []) as ErrorRow[],
    unassigned: (unassigned.data ?? []) as UnassignedDoc[],
  };
}

const LOG_DEFAULT_LIMIT = 100;
const LOG_MAX_LIMIT = 200;

type LogRow = {
  id: number;
  created_at: string;
  channel: "slack" | "web";
  question: string;
  answer: string | null;
  source_chunk_ids: number[] | null;
  latency_ms: number | null;
  users: { email: string | null; display_name: string | null } | null;
};

/** 質問ログ（誰が・いつ・何を聞き・何を答えたか）を新しい順に取る。管理者の確認用 */
export async function loadQueryLogs(db: SupabaseClient, limit = LOG_DEFAULT_LIMIT): Promise<QueryLogEntry[]> {
  const n = Math.min(LOG_MAX_LIMIT, Math.max(1, Math.trunc(limit)));
  const { data, error } = await db
    .from("query_logs")
    .select("id, created_at, channel, question, answer, source_chunk_ids, latency_ms, users(email, display_name)")
    .order("created_at", { ascending: false })
    .limit(n);
  if (error) throw new Error(`質問ログの取得に失敗しました: ${error.message}`);

  return ((data ?? []) as unknown as LogRow[]).map((r) => ({
    id: r.id,
    createdAt: r.created_at,
    channel: r.channel,
    question: r.question,
    answer: r.answer,
    sourceCount: r.source_chunk_ids?.length ?? 0,
    latencyMs: r.latency_ms,
    userLabel: r.users ? (r.users.display_name ?? r.users.email ?? "(不明)") : "(削除済み)",
  }));
}
