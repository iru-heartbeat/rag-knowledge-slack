import type { SupabaseClient } from "@supabase/supabase-js";
import { config } from "../config";
import { embedQuery } from "../ingest/embed";

/** 回答の根拠になるチャンク1件（出典の表示に必要な情報つき） */
export type RetrievedChunk = {
  chunkId: number;
  documentId: string;
  title: string;
  url: string;
  sectionTitle: string | null;
  docDate: string | null;
  docYear: number | null;
  customer: string | null;
  content: string;
  /** 質問との近さ（0〜1。大きいほど近い） */
  similarity: number;
};

/** 絞り込み条件（Web 詳細検索で使う。Slack では通常指定しない） */
export type SearchFilters = {
  departmentId?: number;
  /** "YYYY-MM-DD" */
  dateFrom?: string;
  dateTo?: string;
  /** 客先名の部分一致 */
  customer?: string;
};

export type RetrieveInput = {
  /** 質問した人（users.id）。この人の所属部署で閲覧できる文書だけが対象になる */
  userId: string;
  question: string;
  filters?: SearchFilters;
  topK?: number;
};

export type RetrieveDeps = {
  embed?: (text: string) => Promise<number[]>;
};

const MAX_QUESTION_CHARS = 1000;
const MIN_TOP_K = 1;
const MAX_TOP_K = 20;

/**
 * 質問に関係のあるチャンクを、質問者が見てよい文書の中から探す。
 *
 * 権限の絞り込みは DB 関数 match_chunks が userId の所属部署で行う。この関数は必ずそれを経由し、
 * アプリ側で権限の条件を省略・上書きしない（Slack も Web も共通）。
 * 結果が空なら、呼び出し側は推測せず「見つかりません」と返すこと。
 */
export async function retrieveChunks(
  db: SupabaseClient,
  input: RetrieveInput,
  deps: RetrieveDeps = {},
): Promise<RetrievedChunk[]> {
  const question = input.question.trim().slice(0, MAX_QUESTION_CHARS);
  if (!question) throw new Error("質問が空です");

  const topK = Math.min(MAX_TOP_K, Math.max(MIN_TOP_K, Math.trunc(input.topK ?? config.search.topK)));
  const embed = deps.embed ?? ((t: string) => embedQuery(t));
  const f = input.filters ?? {};

  const { data, error } = await db.rpc("match_chunks", {
    query_embedding: await embed(question),
    p_user_id: input.userId,
    match_count: topK,
    p_department_id: f.departmentId ?? null,
    p_date_from: f.dateFrom ?? null,
    p_date_to: f.dateTo ?? null,
    p_customer: f.customer ?? null,
  });
  if (error) throw new Error(`検索に失敗しました: ${error.message}`);

  return ((data ?? []) as Row[])
    .filter((r) => r.similarity >= config.search.minSimilarity)
    .map((r) => ({
      chunkId: r.chunk_id,
      documentId: r.document_id,
      title: r.title,
      url: r.url,
      sectionTitle: r.section_title,
      docDate: r.doc_date,
      docYear: r.doc_year,
      customer: r.customer,
      content: r.content,
      similarity: r.similarity,
    }));
}

/** match_chunks が返す1行 */
type Row = {
  chunk_id: number;
  document_id: string;
  title: string;
  url: string;
  section_title: string | null;
  doc_date: string | null;
  doc_year: number | null;
  customer: string | null;
  content: string;
  similarity: number;
};
