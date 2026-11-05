import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { config } from "../config";
import { retrieveChunks } from "./retrieve";

type Row = Record<string, unknown>;

const dbRow = (over: Row = {}): Row => ({
  chunk_id: 1,
  document_id: "doc-1",
  title: "提案書.pdf",
  url: "https://example.com/1",
  section_title: "1. 概要",
  doc_date: null,
  doc_year: 2024,
  customer: "地方銀行A",
  content: "本文",
  similarity: 0.8,
  ...over,
});

function fakeDb(result: { data?: Row[]; error?: { message: string } } = { data: [dbRow()] }) {
  const rpc = vi.fn(async () => ({ data: result.data ?? null, error: result.error ?? null }));
  return { db: { rpc } as unknown as SupabaseClient, rpc };
}

const vector = new Array<number>(config.embeddingDimensions).fill(0.1);
const embed = () => vi.fn(async () => vector);

const args = (rpc: ReturnType<typeof vi.fn>) => (rpc.mock.calls[0] as unknown[])[1] as Row;

describe("retrieveChunks", () => {
  it("質問をベクトル化し、ユーザーIDつきで match_chunks を呼ぶ（権限フィルタを省略しない）", async () => {
    const { db, rpc } = fakeDb();
    const e = embed();
    await retrieveChunks(db, { userId: "user-1", question: "  DX支援の事例は？  " }, { embed: e });

    expect(e).toHaveBeenCalledWith("DX支援の事例は？"); // 前後の空白は除く
    expect(rpc).toHaveBeenCalledWith("match_chunks", expect.anything());
    expect(args(rpc)).toMatchObject({
      query_embedding: vector,
      p_user_id: "user-1",
      match_count: config.search.topK,
      p_department_id: null,
      p_date_from: null,
      p_date_to: null,
      p_customer: null,
    });
  });

  it("絞り込み条件(部署・期間・客先)をそのまま渡す", async () => {
    const { db, rpc } = fakeDb();
    await retrieveChunks(
      db,
      {
        userId: "u",
        question: "q",
        filters: { departmentId: 3, dateFrom: "2023-01-01", dateTo: "2023-12-31", customer: "銀行" },
      },
      { embed: embed() },
    );
    expect(args(rpc)).toMatchObject({
      p_department_id: 3,
      p_date_from: "2023-01-01",
      p_date_to: "2023-12-31",
      p_customer: "銀行",
    });
  });

  it("結果を使いやすい形（キャメルケース）に整える", async () => {
    const { db } = fakeDb({ data: [dbRow({ doc_date: "2024-04-01" })] });
    const [c] = await retrieveChunks(db, { userId: "u", question: "q" }, { embed: embed() });
    expect(c).toEqual({
      chunkId: 1,
      documentId: "doc-1",
      title: "提案書.pdf",
      url: "https://example.com/1",
      sectionTitle: "1. 概要",
      docDate: "2024-04-01",
      docYear: 2024,
      customer: "地方銀行A",
      content: "本文",
      similarity: 0.8,
    });
  });

  it("類似度が下限未満のチャンクは捨てる（無関係な文書を根拠にしない）", async () => {
    const { db } = fakeDb({
      data: [
        dbRow({ chunk_id: 1, similarity: config.search.minSimilarity + 0.1 }),
        dbRow({ chunk_id: 2, similarity: config.search.minSimilarity - 0.01 }),
      ],
    });
    const r = await retrieveChunks(db, { userId: "u", question: "q" }, { embed: embed() });
    expect(r.map((c) => c.chunkId)).toEqual([1]);
  });

  it("該当なしは空配列（呼び出し側が『見つかりません』と返す）", async () => {
    const { db } = fakeDb({ data: [] });
    expect(await retrieveChunks(db, { userId: "u", question: "q" }, { embed: embed() })).toEqual([]);
  });

  it("件数は 1〜20 に収める", async () => {
    const a = fakeDb();
    await retrieveChunks(a.db, { userId: "u", question: "q", topK: 999 }, { embed: embed() });
    expect(args(a.rpc).match_count).toBe(20);
    const b = fakeDb();
    await retrieveChunks(b.db, { userId: "u", question: "q", topK: 0 }, { embed: embed() });
    expect(args(b.rpc).match_count).toBe(1);
  });

  it("空の質問は、Embedding も DB も呼ばずにエラー", async () => {
    const { db, rpc } = fakeDb();
    const e = embed();
    await expect(retrieveChunks(db, { userId: "u", question: "   " }, { embed: e })).rejects.toThrow(/質問/);
    expect(e).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("極端に長い質問は先頭だけ使う", async () => {
    const { db } = fakeDb();
    const e = embed();
    await retrieveChunks(db, { userId: "u", question: "あ".repeat(5000) }, { embed: e });
    expect((e.mock.calls[0] as unknown as string[])[0].length).toBe(1000);
  });

  it("DB のエラーは握りつぶさず例外にする", async () => {
    const { db } = fakeDb({ error: { message: "boom" } });
    await expect(retrieveChunks(db, { userId: "u", question: "q" }, { embed: embed() })).rejects.toThrow(/boom/);
  });
});
