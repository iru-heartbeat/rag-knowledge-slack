import type { SupabaseClient } from "@supabase/supabase-js";
import { chunkSections, type Section } from "./chunk";
import { extractDepartments } from "./department";
import { embedTexts } from "./embed";
import { extractMetadata } from "./metadata";
import { parseDocx } from "./parse-docx";
import { NoTextError, parsePdf } from "./parse-pdf";
import { contentHash, isUnchanged, refreshDocumentLocation, saveDocument } from "./upsert";

/** SharePoint などから取得した、取り込み前の1ファイル */
export type SourceFile = {
  sharepointId: string;
  title: string;
  url: string;
  fileType: "pdf" | "docx";
  buffer: Buffer;
};

export type IngestResult =
  | { status: "skipped" }
  | {
      status: "saved";
      documentId: string;
      /** 部署が判定できず、誰にも見えない状態で保存された（管理者の確認が必要） */
      unassigned: boolean;
      /** 部署欄らしき記載はあったが登録名と一致しなかった値（管理者の確認用） */
      unmatchedDepartments: string[];
    };

/** 本文が空で取り込めない文書。やり直しても直らない失敗として、同期処理が区別する */
export class EmptyDocumentError extends Error {
  constructor(title: string) {
    super(`本文が空のため取り込めません（${title}）`);
    this.name = "EmptyDocumentError";
  }
}

/** ファイルが壊れている・暗号化されているなどで読み取れない。やり直しても直らない失敗として、同期処理が区別する */
export class ParseError extends Error {
  constructor(title: string, cause: unknown) {
    super(`ファイルを読み取れませんでした（${title}）: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "ParseError";
  }
}

/** テストで差し替えられるようにした外部依存（既定は本物の OpenAI） */
export type IngestDeps = {
  embed?: (texts: string[]) => Promise<number[][]>;
};

/**
 * 文書1件を取り込む。読み取り → 抽出 → チャンク分割 → Embedding → 保存を1本につなぐ。
 *
 * - 変更がなければ Embedding（時間も費用もかかる）を呼ばずに skipped を返す。
 * - 読み取れない・本文が空などの失敗は例外で返す。呼び出し側（同期処理）が失敗として記録し、他の文書は続行する。
 * - 部署が判定できなくても失敗にはしない。「誰にも見せない」状態で保存し、unassigned で知らせる。
 */
export async function ingestDocument(
  db: SupabaseClient,
  file: SourceFile,
  deps: IngestDeps = {},
): Promise<IngestResult> {
  const hash = contentHash(file.buffer);
  if (await isUnchanged(db, file.sharepointId, hash)) {
    // 中身が同じでも、名前の変更・移動に追従する（Embedding は不要なので軽い更新だけ）
    await refreshDocumentLocation(db, file.sharepointId, file.title, file.url);
    return { status: "skipped" };
  }

  let sections: Section[];
  try {
    sections = file.fileType === "pdf" ? await parsePdf(file.buffer) : await parseDocx(file.buffer);
  } catch (e) {
    // 文字が取り出せない(NoTextError)は専用の扱いのまま。それ以外の読み取り失敗は ParseError にまとめる
    throw e instanceof NoTextError ? e : new ParseError(file.title, e);
  }

  const chunks = chunkSections(sections);
  if (chunks.length === 0) throw new EmptyDocumentError(file.title);

  // 部署・客先・日付は文書冒頭の記載から正規表現で抽出する（AI の推測は使わない。権限に直結するため）
  const known = await fetchDepartmentNames(db);
  const { departments, unmatched } = extractDepartments(sections, known);
  const meta = extractMetadata(sections);

  const embed = deps.embed ?? ((texts: string[]) => embedTexts(texts));
  const vectors = await embed(chunks.map((c) => c.content));

  const saved = await saveDocument(db, {
    sharepointId: file.sharepointId,
    title: file.title,
    url: file.url,
    fileType: file.fileType,
    contentHash: hash,
    departments,
    customer: meta.customer,
    docDate: meta.docDate,
    docYear: meta.docYear,
    chunks: chunks.map((c, i) => ({ ...c, embedding: vectors[i] })),
  });

  return {
    status: "saved",
    documentId: saved.documentId,
    unassigned: saved.unassigned,
    unmatchedDepartments: unmatched,
  };
}

async function fetchDepartmentNames(db: SupabaseClient): Promise<string[]> {
  const { data, error } = await db.from("departments").select("name");
  if (error) throw new Error(`部署一覧の取得に失敗しました: ${error.message}`);
  return (data ?? []).map((d: { name: string }) => d.name);
}
