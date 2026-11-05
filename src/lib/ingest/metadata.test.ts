import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { extractMetadata } from "./metadata";
import { parsePdf } from "./parse-pdf";

const doc = (text: string) => [{ title: null, text }];

describe("extractMetadata: 日付", () => {
  it.each([
    ["作成: 2024年4月1日", "2024-04-01", 2024],
    ["作成日: 2023/12/5", "2023-12-05", 2023],
    ["作成日 2023-01-31", "2023-01-31", 2023],
    ["作成：２０２４年４月１日", "2024-04-01", 2024], // 全角
    ["発行日: 2022.3.9", "2022-03-09", 2022],
  ])("%s → 年月日", (text, date, year) => {
    expect(extractMetadata(doc(text))).toMatchObject({ docDate: date, docYear: year });
  });

  it.each([
    ["作成: 2024年", 2024],
    ["作成: 2023年4月", 2023], // 年月だけなら年のみ
  ])("%s → 年だけ", (text, year) => {
    expect(extractMetadata(doc(text))).toMatchObject({ docDate: null, docYear: year });
  });

  it("実在しない日付は年だけにする", () => {
    expect(extractMetadata(doc("作成日: 2024年2月30日"))).toMatchObject({ docDate: null, docYear: 2024 });
  });

  it("項目名のない日付は採用しない（納期など別の日付の可能性）", () => {
    expect(extractMetadata(doc("納期は2025年3月31日です。"))).toMatchObject({ docDate: null, docYear: null });
  });

  it("作成部署の欄を日付の欄と取り違えない", () => {
    expect(extractMetadata(doc("作成部署: 営業部"))).toMatchObject({ docDate: null, docYear: null });
  });
});

describe("extractMetadata: 年の範囲チェック（レビュー指摘）", () => {
  // DB の doc_year は 1900〜2100 のみ。範囲外を渡すと文書ごと保存に失敗する
  it.each([
    ["作成: 1850年"],
    ["作成日: 9999"],
    ["作成: 1899年"],
    ["作成: 2101年"],
    ["発行 12345"], // 5桁の番号の先頭4桁を年として拾わない
    ["作成: 1850年1月1日"], // 範囲外の年は年月日でも採用しない
  ])("%s → 年なし", (text) => {
    expect(extractMetadata(doc(text))).toMatchObject({ docDate: null, docYear: null });
  });

  it.each([
    ["作成: 1900年", 1900],
    ["作成: 2100年", 2100],
  ])("%s → 範囲の端でも採用する", (text, year) => {
    expect(extractMetadata(doc(text))).toMatchObject({ docYear: year });
  });
});

describe("extractMetadata: 確度の高い欄を優先する（レビュー指摘）", () => {
  it("コロン付きの欄が年だけでも確定し、空白区切りの文の日付で上書きしない", () => {
    const m = extractMetadata(doc("作成: 2023年\n発行 2024/3/5 以降は新料金"));
    expect(m).toMatchObject({ docDate: null, docYear: 2023 });
  });

  it("コロン付きの欄に有効な値が無いときだけ、空白区切りの欄を使う", () => {
    expect(extractMetadata(doc("作成: 1850年\n発行日 2024-03-05"))).toMatchObject({
      docDate: "2024-03-05",
      docYear: 2024,
    });
  });
});

describe("extractMetadata: 客先", () => {
  it.each([
    ["客先: 地方銀行A", "地方銀行A"],
    ["顧客：株式会社サンプル", "株式会社サンプル"],
    ["部署: 戦略 / 客先: 製造業B / 作成: 2024年", "製造業B"],
    ["取引先 小売業C", "小売業C"],
  ])("%s → %s", (text, expected) => {
    expect(extractMetadata(doc(text)).customer).toBe(expected);
  });

  it("表紙の文に「顧客」が先に出ても、コロン付きの正しい欄を優先する（レビュー指摘）", () => {
    expect(extractMetadata(doc("顧客 向け提案書\n客先: 株式会社A")).customer).toBe("株式会社A");
    expect(extractMetadata(doc("取引先 一覧\n部署: 営業 / 客先: 製造業B")).customer).toBe("製造業B");
  });

  it("日付も、コロン付きの欄を空白区切りの文より優先する", () => {
    const m = extractMetadata(doc("作成 手順書 2024年\n作成: 2023年"));
    expect(m).toMatchObject({ docDate: null, docYear: 2023 });
  });

  it("記載がなければ null", () => {
    expect(extractMetadata(doc("議事録")).customer).toBeNull();
  });

  it("主要客先のように別の語の一部は拾わない", () => {
    expect(extractMetadata(doc("主要客先: A社")).customer).toBeNull();
  });
});

const SAMPLE_DIR = join(__dirname, "../../../テスト用PDF_元ファイル");

describe.skipIf(!existsSync(SAMPLE_DIR))("サンプルPDF（実データ）", () => {
  it.each([
    ["case7-doc1-strategy-dx-bank.pdf", "地方銀行A", 2024],
    ["case7-doc2-hr-engagement-report.pdf", "製造業B", 2024],
    ["case7-doc3-it-cloud-migration.pdf", "小売業C", 2023],
    ["case7-doc4-sales-proposal-retail.pdf", "小売チェーンD", 2024],
  ])("%s の客先=%s, 作成年=%i", async (file, customer, year) => {
    const sections = await parsePdf(readFileSync(join(SAMPLE_DIR, file)));
    expect(extractMetadata(sections)).toEqual({ customer, docDate: null, docYear: year });
  });
});
