import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { config } from "../config";
import { contentHash, isUnchanged, saveDocument, type DocumentRecord } from "./upsert";

type Row = Record<string, unknown>;

/** Supabase クライアントの偽物。テーブルごとの返却行と、rpc の結果を指定できる */
function fakeDb(opts: { tables?: Record<string, Row[]>; rpcResult?: { data?: unknown; error?: { message: string } } } = {}) {
  const rpc = vi.fn(async () => opts.rpcResult ?? { data: "doc-uuid", error: null });
  const from = (table: string) => {
    const rows = opts.tables?.[table] ?? [];
    const result = { data: rows, error: null };
    const builder = {
      select: () => builder,
      eq: () => builder,
      in: () => Promise.resolve(result),
      maybeSingle: () => Promise.resolve({ data: rows[0] ?? null, error: null }),
    };
    return builder;
  };
  return { db: { from, rpc } as unknown as SupabaseClient, rpc };
}

const vec = () => new Array<number>(config.embeddingDimensions).fill(0.1);

const record = (over: Partial<DocumentRecord> = {}): DocumentRecord => ({
  sharepointId: "sp-1",
  title: "提案書",
  url: "https://example.com/1",
  fileType: "pdf",
  contentHash: "h1",
  departments: ["営業"],
  customer: "地方銀行A",
  docDate: null,
  docYear: 2024,
  chunks: [{ sectionTitle: "1. 概要", sectionOrder: 0, content: "本文", embedding: vec() }],
  ...over,
});

describe("contentHash", () => {
  it("同じ中身なら同じ値、違えば違う値", () => {
    expect(contentHash(Buffer.from("abc"))).toBe(contentHash(Buffer.from("abc")));
    expect(contentHash(Buffer.from("abc"))).not.toBe(contentHash(Buffer.from("abd")));
  });
  it("SHA-256 の16進64文字", () => {
    expect(contentHash(Buffer.from("abc"))).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("isUnchanged", () => {
  // 「処理済みで、今の設定のまま」の文書の行。ここから1項目ずつ変えて、再処理される条件を確かめる
  const stored = (over: Row = {}): Row => ({
    content_hash: "h1",
    status: "active",
    embedding_model: config.embeddingModel,
    pipeline_version: config.pipelineVersion,
    document_access: [{ department_id: 5 }],
    ...over,
  });
  const check = (row: Row) => isUnchanged(fakeDb({ tables: { documents: [row] } }).db, "sp-1", "h1");

  it("未登録なら false", async () => {
    expect(await isUnchanged(fakeDb().db, "sp-1", "h1")).toBe(false);
  });
  it("全て一致していれば true（スキップしてよい）", async () => {
    expect(await check(stored())).toBe(true);
  });
  it("指紋が違えば（内容が更新されていれば）false", async () => {
    expect(await check(stored({ content_hash: "h0" }))).toBe(false);
  });
  it("削除扱いの文書は、指紋が同じでも false（復活させるため再保存する）", async () => {
    expect(await check(stored({ status: "deleted" }))).toBe(false);
  });

  describe("設定や規則が変わったら再処理する（レビュー指摘）", () => {
    it("部署なし（誰にも見えない）の文書は、指紋が同じでも毎回やり直す", async () => {
      expect(await check(stored({ document_access: [] }))).toBe(false);
    });
    it("Embedding モデルが変わっていれば false", async () => {
      expect(await check(stored({ embedding_model: "other-model" }))).toBe(false);
    });
    it("処理バージョンが違えば false（抽出規則を直したとき）", async () => {
      expect(await check(stored({ pipeline_version: config.pipelineVersion - 1 }))).toBe(false);
    });
    it("モデルやバージョンが未記録の古い行も false", async () => {
      expect(await check(stored({ embedding_model: null, pipeline_version: null }))).toBe(false);
    });
  });
});

describe("saveDocument", () => {
  const deptTable = { departments: [{ id: 5, name: "営業" }, { id: 4, name: "人事" }] };

  it("部署名をIDに変換し、DB関数 upsert_document を呼ぶ", async () => {
    const { db, rpc } = fakeDb({ tables: deptTable });
    const result = await saveDocument(db, record({ departments: ["営業", "人事"] }));

    expect(result).toEqual({ documentId: "doc-uuid", unassigned: false });
    const [fn, args] = rpc.mock.calls[0] as unknown as [string, Record<string, any>];
    expect(fn).toBe("upsert_document");
    expect(args.p_department_ids).toEqual([5, 4]); // 指定順（先頭が主たる部署）
    expect(args.p_doc).toMatchObject({ sharepoint_id: "sp-1", customer: "地方銀行A", doc_year: 2024, content_hash: "h1" });
    // 再処理の判定に使うため、どのモデル・どの規則バージョンで処理したかも一緒に保存する
    expect(args.p_doc).toMatchObject({ embedding_model: config.embeddingModel, pipeline_version: config.pipelineVersion });
    expect(args.p_chunks[0]).toMatchObject({ section_title: "1. 概要", section_order: 0, embedding_model: config.embeddingModel });
    expect(args.p_chunks[0].token_count).toBe(2); // 「本文」の目安トークン数（NULL のまま保存しない）
  });

  it("部署が判定できない文書は、権限なし(unassigned)で保存する", async () => {
    const { db, rpc } = fakeDb();
    const result = await saveDocument(db, record({ departments: [] }));
    expect(result.unassigned).toBe(true);
    expect((rpc.mock.calls[0] as unknown as [string, Record<string, unknown>])[1].p_department_ids).toEqual([]);
  });

  it("未登録の部署名が混ざっていたら保存しない（権限の付け間違い防止）", async () => {
    const { db, rpc } = fakeDb({ tables: deptTable });
    await expect(saveDocument(db, record({ departments: ["営業", "存在しない部"] }))).rejects.toThrow("存在しない部");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("Embedding の次元数が違えば保存しない", async () => {
    const { db, rpc } = fakeDb({ tables: deptTable });
    const bad = record({ chunks: [{ sectionTitle: null, sectionOrder: 0, content: "x", embedding: [0.1, 0.2] }] });
    await expect(saveDocument(db, bad)).rejects.toThrow("次元数");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("DB がエラーを返したら、文書名つきの例外にする", async () => {
    const { db } = fakeDb({ tables: deptTable, rpcResult: { error: { message: "boom" } } });
    await expect(saveDocument(db, record())).rejects.toThrow(/提案書.*boom/);
  });
});
