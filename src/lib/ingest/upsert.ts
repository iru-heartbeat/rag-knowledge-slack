import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { config } from "../config";
import { estimateTokens, type Chunk } from "./chunk";

export type EmbeddedChunk = Chunk & { embedding: number[] };

/** DB に保存する1文書分の情報（読み取り・メタデータ抽出・Embedding が済んだもの） */
export type DocumentRecord = {
  sharepointId: string;
  title: string;
  url: string;
  fileType: "pdf" | "docx";
  contentHash: string;
  /** 閲覧を許可する部署名（department.ts の抽出結果）。空なら誰にも見せない */
  departments: string[];
  customer: string | null;
  docDate: string | null;
  docYear: number | null;
  chunks: EmbeddedChunk[];
};

export type SaveResult = {
  documentId: string;
  /** 部署が判定できず、誰にも見えない状態で保存された（管理者の確認が必要） */
  unassigned: boolean;
};

/** ファイルの中身から作る指紋。中身が同じなら同じ値になるので、変更の有無の判定に使う */
export function contentHash(buffer: Buffer | Uint8Array): string {
  return createHash("sha256").update(buffer).digest("hex");
}

/**
 * 取り込み済みで、やり直す必要がないか。
 * Embedding の生成には時間も費用もかかるため、これが true なら以降の処理を丸ごと省く。
 *
 * ファイルの中身が同じでも、次の場合は false（=再処理する）:
 *  - Embedding モデルが変わった（古いモデルのベクトルは新しい質問と比較できない）
 *  - 取り込みの規則の版数（config.pipelineVersion）が変わった（部署・客先などの抽出を直したとき）
 *  - 部署が判定できず、誰にも見えない状態になっている（規則を直せば見えるようになる可能性がある）
 */
export async function isUnchanged(
  db: SupabaseClient,
  sharepointId: string,
  hash: string,
): Promise<boolean> {
  const { data, error } = await db
    .from("documents")
    .select("content_hash, status, embedding_model, pipeline_version, document_access(department_id)")
    .eq("sharepoint_id", sharepointId)
    .maybeSingle();
  if (error) throw new Error(`文書の確認に失敗しました: ${error.message}`);
  if (!data) return false;

  const access = (data.document_access as unknown[] | null) ?? [];
  return (
    data.status === "active" &&
    data.content_hash === hash &&
    data.embedding_model === config.embeddingModel &&
    data.pipeline_version === config.pipelineVersion &&
    access.length > 0
  );
}

/**
 * 中身が同じ文書の、文書名とリンク(URL)だけを更新する。
 * SharePoint でファイル名を変えたりフォルダを移したりしても中身は同じなので、再処理（Embedding）はされない。
 * そのままだと出典リンクが古い URL のまま壊れるため、追従させる。
 */
export async function refreshDocumentLocation(
  db: SupabaseClient,
  sharepointId: string,
  title: string,
  url: string,
): Promise<void> {
  // 入手元がリンクを返さなかった（空）場合に、正しい既存のリンクを空で上書きしない
  const patch = url ? { title, url } : { title };
  const { error } = await db.from("documents").update(patch).eq("sharepoint_id", sharepointId);
  if (error) throw new Error(`文書名・リンクの更新に失敗しました: ${error.message}`);
}

/**
 * 文書1件を保存する。同じ sharepointId があれば、チャンクと権限ごと入れ替える（重複しない）。
 * 実際の書き込みは DB 関数 upsert_document が1つのトランザクションで行うため、
 * 途中で失敗しても「古いチャンクが消えたまま」のような壊れた状態にはならない。
 */
export async function saveDocument(db: SupabaseClient, doc: DocumentRecord): Promise<SaveResult> {
  for (const c of doc.chunks) {
    if (c.embedding.length !== config.embeddingDimensions) {
      throw new Error(
        `Embedding の次元数が想定外です（期待 ${config.embeddingDimensions} / 実際 ${c.embedding.length}）`,
      );
    }
  }

  const departmentIds = await resolveDepartmentIds(db, doc.departments);

  const { data, error } = await db.rpc("upsert_document", {
    p_doc: {
      sharepoint_id: doc.sharepointId,
      title: doc.title,
      url: doc.url,
      file_type: doc.fileType,
      customer: doc.customer,
      doc_date: doc.docDate,
      doc_year: doc.docYear,
      content_hash: doc.contentHash,
      embedding_model: config.embeddingModel,
      pipeline_version: config.pipelineVersion,
    },
    p_department_ids: departmentIds,
    p_chunks: doc.chunks.map((c) => ({
      section_title: c.sectionTitle,
      section_order: c.sectionOrder,
      content: c.content,
      token_count: estimateTokens(c.content),
      embedding: c.embedding,
      embedding_model: config.embeddingModel,
    })),
  });
  if (error) throw new Error(`文書の保存に失敗しました（${doc.title}）: ${error.message}`);

  return { documentId: data as string, unassigned: departmentIds.length === 0 };
}

/** 部署名 → 部署ID。登録されていない名前が混ざっていたら、権限の付け間違いを防ぐため保存しない */
async function resolveDepartmentIds(db: SupabaseClient, names: string[]): Promise<number[]> {
  if (names.length === 0) return [];
  const { data, error } = await db.from("departments").select("id, name").in("name", names);
  if (error) throw new Error(`部署の取得に失敗しました: ${error.message}`);

  const byName = new Map((data ?? []).map((d: { id: number; name: string }) => [d.name, d.id]));
  const missing = names.filter((n) => !byName.has(n));
  if (missing.length > 0) throw new Error(`未登録の部署です: ${missing.join(", ")}`);
  return names.map((n) => byName.get(n)!); // 先頭が主たる部署になる
}
