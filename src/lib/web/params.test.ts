import { describe, expect, it } from "vitest";
import { parseSearchParams, safeHref } from "./params";

const ALLOWED = [1, 5];

describe("parseSearchParams", () => {
  it("検索語が無ければ empty（初めて画面を開いた状態）", () => {
    expect(parseSearchParams({}, ALLOWED)).toEqual({ kind: "empty" });
    expect(parseSearchParams({ q: "   " }, ALLOWED)).toEqual({ kind: "empty" });
  });

  it("検索語と絞り込み条件を整える", () => {
    const r = parseSearchParams(
      { q: " DXの進め方 ", dept: "5", customer: " 地方銀行 ", from: "2023-01-01", to: "2024-12-31" },
      ALLOWED,
    );
    expect(r).toEqual({
      kind: "ok",
      question: "DXの進め方",
      filters: { departmentId: 5, customer: "地方銀行", dateFrom: "2023-01-01", dateTo: "2024-12-31" },
    });
  });

  it("絞り込みは任意。空の項目は無視する", () => {
    expect(parseSearchParams({ q: "x", dept: "", customer: "", from: "", to: "" }, ALLOWED)).toEqual({
      kind: "ok",
      question: "x",
      filters: {},
    });
  });

  it("自分の所属でない部署を指定されたらエラー（フォームを書き換えても範囲を広げられない）", () => {
    expect(parseSearchParams({ q: "x", dept: "3" }, ALLOWED)).toMatchObject({ kind: "error" });
    expect(parseSearchParams({ q: "x", dept: "abc" }, ALLOWED)).toMatchObject({ kind: "error" });
  });

  it("日付の形式・実在・前後関係を検査する", () => {
    expect(parseSearchParams({ q: "x", from: "2024/01/01" }, ALLOWED)).toMatchObject({ kind: "error" });
    expect(parseSearchParams({ q: "x", from: "2024-02-30" }, ALLOWED)).toMatchObject({ kind: "error" });
    expect(parseSearchParams({ q: "x", from: "2024-05-01", to: "2024-04-01" }, ALLOWED)).toMatchObject({
      kind: "error",
    });
  });

  it("客先・検索語が長すぎる場合はエラー", () => {
    expect(parseSearchParams({ q: "x", customer: "あ".repeat(101) }, ALLOWED)).toMatchObject({ kind: "error" });
    expect(parseSearchParams({ q: "あ".repeat(1001) }, ALLOWED)).toMatchObject({ kind: "error" });
  });

  it("同じ項目が複数渡されたら、最初の値だけを使う", () => {
    expect(parseSearchParams({ q: ["a", "b"] }, ALLOWED)).toMatchObject({ kind: "ok", question: "a" });
  });
});

describe("safeHref", () => {
  it("http(s) だけをリンクにする（javascript: や file: は文書名のみ表示にする）", () => {
    expect(safeHref("https://example.com/a.pdf")).toBe("https://example.com/a.pdf");
    expect(safeHref("http://example.com/a")).toBe("http://example.com/a");
    expect(safeHref("javascript:alert(1)")).toBeNull();
    expect(safeHref("file:///C:/a.pdf")).toBeNull();
    expect(safeHref("")).toBeNull();
  });
});
