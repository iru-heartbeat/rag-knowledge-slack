import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { config } from "../config";
import { ingestDocument, ParseError, type SourceFile } from "./pipeline";
import { contentHash } from "./upsert";

type Row = Record<string, unknown>;

const DEPARTMENTS = ["戦略", "業務", "IT", "人事", "営業", "管理"].map((name, i) => ({ id: i + 1, name }));

/** Supabase の偽物。documents（変更判定用）・departments・rpc(upsert_document) だけを再現する */
function fakeDb(opts: { stored?: Row | null } = {}) {
  const rpc = vi.fn(async () => ({ data: "doc-uuid", error: null }));
  const updates: Array<{ table: string; patch: Row; eq: Array<[string, unknown]> }> = [];
  const from = (table: string) => {
    const rows: Row[] = table === "departments" ? DEPARTMENTS : opts.stored ? [opts.stored] : [];
    const rec = { table, patch: {} as Row, eq: [] as Array<[string, unknown]> };
    const builder = {
      update: (patch: Row) => ((rec.patch = patch), updates.push(rec), builder),
      select: () => builder,
      eq: (c: string, v: unknown) => (rec.eq.push([c, v]), builder),
      in: (_col: string, names: string[]) =>
        Promise.resolve({ data: rows.filter((r) => names.includes(r.name as string)), error: null }),
      maybeSingle: () => Promise.resolve({ data: rows[0] ?? null, error: null }),
      then: (resolve: (v: unknown) => unknown) => resolve({ data: rows, error: null }),
    };
    return builder;
  };
  return { db: { from, rpc } as unknown as SupabaseClient, rpc, updates };
}

/** Embedding の偽物（OpenAI を呼ばない）。入力と同じ件数のダミーベクトルを返す */
const fakeEmbed = () =>
  vi.fn(async (texts: string[]) => texts.map(() => new Array<number>(config.embeddingDimensions).fill(0.1)));

const SAMPLE_DIR = join(__dirname, "../../../テスト用PDF_元ファイル");

describe.skipIf(!existsSync(SAMPLE_DIR))("ingestDocument（サンプルPDF）", () => {
  const file = (name: string, over: Partial<SourceFile> = {}): SourceFile => ({
    sharepointId: `sp-${name}`,
    title: name,
    url: `https://example.com/${name}`,
    fileType: "pdf",
    buffer: existsSync(join(SAMPLE_DIR, name)) ? readFileSync(join(SAMPLE_DIR, name)) : Buffer.alloc(0),
    ...over,
  });

  it("読み取り→抽出→Embedding→保存を通して、部署・客先・年つきで保存する", async () => {
    const { db, rpc } = fakeDb();
    const embed = fakeEmbed();
    const r = await ingestDocument(db, file("case7-doc1-strategy-dx-bank.pdf"), { embed });

    expect(r).toMatchObject({ status: "saved", documentId: "doc-uuid", unassigned: false });
    expect(embed).toHaveBeenCalledTimes(1);

    const arg = (rpc.mock.calls[0] as unknown[])[1] as {
      p_doc: Row;
      p_department_ids: number[];
      p_chunks: Row[];
    };
    expect(arg.p_doc).toMatchObject({ customer: "地方銀行A", doc_year: 2024, file_type: "pdf" });
    expect(arg.p_department_ids).toEqual([1]); // 戦略
    expect(arg.p_chunks.length).toBeGreaterThan(0);
  });

  it("4件とも部署が判定でき、誰にも見えない状態にならない", async () => {
    for (const name of [
      "case7-doc1-strategy-dx-bank.pdf",
      "case7-doc2-hr-engagement-report.pdf",
      "case7-doc3-it-cloud-migration.pdf",
      "case7-doc4-sales-proposal-retail.pdf",
    ]) {
      const { db } = fakeDb();
      const r = await ingestDocument(db, file(name), { embed: fakeEmbed() });
      expect(r.status === "saved" && r.unassigned, name).toBe(false);
    }
  });

  it("取り込み済みで何も変わっていなければ、Embedding も保存もせず skipped", async () => {
    const f = file("case7-doc1-strategy-dx-bank.pdf");
    const { db, rpc, updates } = fakeDb({
      stored: {
        content_hash: contentHash(f.buffer),
        status: "active",
        embedding_model: config.embeddingModel,
        pipeline_version: config.pipelineVersion,
        document_access: [{ department_id: 1 }],
      },
    });
    const embed = fakeEmbed();
    const r = await ingestDocument(db, f, { embed });

    expect(r.status).toBe("skipped");
    expect(embed).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
    // 中身が同じでも、名前の変更・フォルダの移動に追従するため、文書名とリンクだけは更新する
    expect(updates).toEqual([
      {
        table: "documents",
        patch: { title: f.title, url: f.url },
        eq: [["sharepoint_id", f.sharepointId]],
      },
    ]);
  });

  it("入手元がリンクを返さなかった(空)場合は、文書名だけ更新し、既存のリンクを空で上書きしない", async () => {
    const f = file("case7-doc1-strategy-dx-bank.pdf", { url: "" });
    const { db, updates } = fakeDb({
      stored: {
        content_hash: contentHash(f.buffer),
        status: "active",
        embedding_model: config.embeddingModel,
        pipeline_version: config.pipelineVersion,
        document_access: [{ department_id: 1 }],
      },
    });
    await ingestDocument(db, f, { embed: fakeEmbed() });
    expect(updates[0].patch).toEqual({ title: f.title });
  });

  it("読み取れない（壊れた）ファイルは ParseError。同期側が『やり直しても直らない失敗』と判断できる", async () => {
    const { db, rpc } = fakeDb();
    const err = await ingestDocument(
      db,
      { sharepointId: "x", title: "壊れ.docx", url: "u", fileType: "docx", buffer: Buffer.from("not a docx") },
      { embed: fakeEmbed() },
    ).catch((e) => e);
    expect(err).toBeInstanceOf(ParseError);
    expect(err.message).toContain("壊れ.docx");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("文字が取り出せない PDF は例外（呼び出し側が失敗として記録する）", async () => {
    const { db, rpc } = fakeDb();
    await expect(
      ingestDocument(db, file("x.pdf", { buffer: Buffer.from("%PDF-1.4 broken") }), { embed: fakeEmbed() }),
    ).rejects.toThrow();
    expect(rpc).not.toHaveBeenCalled();
  });
});
