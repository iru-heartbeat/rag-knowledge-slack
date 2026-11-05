import { describe, expect, it } from "vitest";
import type { Section } from "./chunk";
import { documentHead } from "./head";

describe("documentHead", () => {
  it("見出しと本文をつなぎ、全角を半角に統一する", () => {
    const head = documentHead([{ title: null, text: "作成：２０２４年" }]);
    expect(head).toBe("作成:2024年");
  });

  it("最大文字数で切る", () => {
    expect(documentHead([{ title: null, text: "あ".repeat(5000) }])).toHaveLength(2000);
    expect(documentHead([{ title: null, text: "あ".repeat(50) }], 10)).toHaveLength(10);
  });

  it("階層見出しは末尾の見出しだけを付ける（親の繰り返しで枠を使い切らない）", () => {
    const head = documentHead([{ title: "第1章 > 1.1 背景 > 詳細", text: "本文" }]);
    expect(head).toBe("詳細\n本文");
  });

  it("枠が埋まった後ろのセクションは読まない（巨大な文書で無駄な処理をしない）", () => {
    const poison = {
      title: null,
      get text(): string {
        throw new Error("後ろのセクションまで処理してしまった");
      },
    } as Section;
    expect(() => documentHead([{ title: null, text: "あ".repeat(3000) }, poison])).not.toThrow();
  });

  it("1つのセクションが巨大でも、冒頭の分だけを正規化する", () => {
    const huge = "ア".repeat(5_000_000);
    const t0 = performance.now();
    documentHead([{ title: null, text: huge }]);
    expect(performance.now() - t0).toBeLessThan(200);
  });

  it("同じ配列で再度呼んでも同じ結果を返す（結果は使い回される）", () => {
    const sections = [{ title: null, text: "部署: 営業" }];
    expect(documentHead(sections)).toBe(documentHead(sections));
  });
});
