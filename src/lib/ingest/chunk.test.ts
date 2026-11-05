import { describe, expect, it } from "vitest";
import { config } from "../config";
import { chunkSections, estimateTokens, splitText } from "./chunk";

describe("見出しを付けてもチャンクが上限を超えない（レビュー指摘）", () => {
  const deepTitle = "第1章 プロジェクト全体の概要と背景 > 1.1 現状の課題と今後の方針について > 1.1.1 詳細な分析結果の整理と考察";

  it("深い階層の見出しでも、全チャンクが maxChars 以内に収まる", () => {
    const text = "これは本文の一文です。".repeat(300);
    const chunks = chunkSections([{ title: deepTitle, text }]);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.content.length).toBeLessThanOrEqual(config.chunk.maxChars);
  });

  it("DB保存用の sectionTitle は省略せず全文のまま", () => {
    const [c] = chunkSections([{ title: deepTitle, text: "本文" }]);
    expect(c.sectionTitle).toBe(deepTitle);
  });

  it("内容の先頭に付ける見出しは80文字までで、長いときは末尾（より具体的な側）を残す", () => {
    const [c] = chunkSections([{ title: deepTitle, text: "本文" }]);
    const prefix = c.content.split("\n")[0];
    expect(prefix.length).toBeLessThanOrEqual(80);
    expect(prefix.endsWith("詳細な分析結果の整理と考察")).toBe(true);
  });

  it("短い見出しはそのまま付く", () => {
    const [c] = chunkSections([{ title: "概要", text: "本文" }]);
    expect(c.content).toBe("概要\n本文");
  });
});

describe("estimateTokens", () => {
  it.each([
    ["", 0],
    ["あいう", 3], // 日本語は1文字≒1トークン
    ["abcd", 1], // 英数は4文字≒1トークン
    ["abcde", 2], // 端数は切り上げ
    ["日本語abcd", 4],
  ])("%s → %i", (text, expected) => {
    expect(estimateTokens(text)).toBe(expected);
  });
});

describe("chunkSections", () => {
  it("短いセクションはそのまま1チャンクになり、見出しが先頭に付く", () => {
    const chunks = chunkSections([{ title: "概要", text: "本文です。" }]);
    expect(chunks).toEqual([{ sectionTitle: "概要", sectionOrder: 0, content: "概要\n本文です。" }]);
  });

  it("見出しなしのセクションは本文だけになる", () => {
    const [c] = chunkSections([{ title: null, text: "見出しなし" }]);
    expect(c.content).toBe("見出しなし");
  });

  it("空のセクションは捨て、通し番号は連続する", () => {
    const chunks = chunkSections([
      { title: "A", text: "a" },
      { title: "B", text: "   " },
      { title: "C", text: "c" },
    ]);
    expect(chunks.map((c) => c.sectionOrder)).toEqual([0, 1]);
    expect(chunks.map((c) => c.sectionTitle)).toEqual(["A", "C"]);
  });

  it("長いセクションは複数に分かれ、同じ見出しを持つ", () => {
    const text = "あ".repeat(250);
    const chunks = chunkSections([{ title: "長い", text }], { maxChars: 100, overlapChars: 10 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.sectionTitle === "長い")).toBe(true);
  });

  it("overlap が max 以上ならエラー", () => {
    expect(() => chunkSections([], { maxChars: 10, overlapChars: 10 })).toThrow();
  });
});

describe("splitText", () => {
  it("上限以下なら分割しない", () => {
    expect(splitText("短い", 100, 10)).toEqual(["短い"]);
  });

  it("全ピースが上限文字数以内に収まる", () => {
    const text = "これは一文です。".repeat(100);
    for (const piece of splitText(text, 80, 10)) {
      expect(piece.length).toBeLessThanOrEqual(80);
    }
  });

  it("文の途中ではなく句点で切れる（切れ目がある場合）", () => {
    const text = "一つ目の文です。二つ目の文です。三つ目の文です。";
    const pieces = splitText(text, 20, 0);
    expect(pieces.every((p) => p.endsWith("。"))).toBe(true);
  });

  it("2つ目以降は直前の末尾が重なる", () => {
    const text = "あ".repeat(100) + "\n\n" + "い".repeat(100);
    const [first, second] = splitText(text, 120, 20);
    expect(second.startsWith(first.slice(-20))).toBe(true);
  });

  describe("BMP外の文字（𠮷・絵文字）を途中で切らない（レビュー指摘）", () => {
    // 孤立したサロゲート（ペアの片方だけ）。DB保存やAPI送信でエラーになる
    const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

    it("区切りのない長文を強制分割しても孤立サロゲートが出ない", () => {
      for (const piece of splitText("𠮷".repeat(300), 101, 11)) {
        expect(piece).not.toMatch(LONE);
      }
    });

    it("overlap の切り出し位置がペアの途中でも壊れない", () => {
      const text = "あ".repeat(100) + "\n\n" + "😀".repeat(100);
      for (const piece of splitText(text, 120, 21)) {
        expect(piece).not.toMatch(LONE);
      }
    });

    it("chunkSections の結果も全てwell-formed", () => {
      const chunks = chunkSections([{ title: "名簿", text: "𩸽𠮷😀".repeat(200) }], { maxChars: 50, overlapChars: 7 });
      for (const c of chunks) expect(c.content).not.toMatch(LONE);
    });
  });

  it("区切りのない長文も文字数で強制分割できる", () => {
    const pieces = splitText("x".repeat(1000), 100, 10);
    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.every((p) => p.length <= 100)).toBe(true);
  });
});
