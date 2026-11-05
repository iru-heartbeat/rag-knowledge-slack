import { describe, expect, it, vi } from "vitest";
import { config } from "../config";
import { embedQuery, embedTexts, type EmbeddingClient } from "./embed";

const DIM = config.embeddingDimensions;

/** 入力文字列ごとに識別できるベクトルを返す偽クライアント（先頭要素に入力の長さを入れる） */
function fakeClient(opts: { shuffle?: boolean; dim?: number; dropOne?: boolean } = {}) {
  const create = vi.fn(async ({ input }: { model: string; input: string[] }) => {
    let data = input.map((text, index) => ({
      index,
      embedding: [text.length, ...new Array((opts.dim ?? DIM) - 1).fill(0)],
    }));
    if (opts.shuffle) data = data.reverse();
    if (opts.dropOne) data = data.slice(1);
    return { data };
  });
  return { client: { embeddings: { create } } as EmbeddingClient, create };
}

describe("embedTexts", () => {
  it("空配列ならAPIを呼ばない", async () => {
    const { client, create } = fakeClient();
    expect(await embedTexts([], client)).toEqual([]);
    expect(create).not.toHaveBeenCalled();
  });

  it("設定のモデル名でAPIを呼ぶ", async () => {
    const { client, create } = fakeClient();
    await embedTexts(["a"], client);
    expect(create.mock.calls[0][0].model).toBe(config.embeddingModel);
  });

  it("64件ごとに分けて呼び、入力と同じ順序で返す", async () => {
    const { client, create } = fakeClient();
    const texts = Array.from({ length: 150 }, (_, i) => "x".repeat(i + 1));
    const vectors = await embedTexts(texts, client);
    expect(create).toHaveBeenCalledTimes(3); // 64 + 64 + 22
    expect(vectors.map((v) => v[0])).toEqual(texts.map((t) => t.length));
  });

  it("応答の順序が入れ替わっていても index で並べ直す", async () => {
    const { client } = fakeClient({ shuffle: true });
    const vectors = await embedTexts(["a", "bb", "ccc"], client);
    expect(vectors.map((v) => v[0])).toEqual([1, 2, 3]);
  });

  it("次元数が想定と違えばエラー", async () => {
    const { client } = fakeClient({ dim: 3072 });
    await expect(embedTexts(["a"], client)).rejects.toThrow("次元数");
  });

  it("応答の件数が足りなければエラー", async () => {
    const { client } = fakeClient({ dropOne: true });
    await expect(embedTexts(["a", "b"], client)).rejects.toThrow("件数");
  });
});

describe("embedQuery", () => {
  it("1件のベクトルを返す", async () => {
    const { client } = fakeClient();
    const v = await embedQuery("質問", client);
    expect(v).toHaveLength(DIM);
    expect(v[0]).toBe(2);
  });
});
