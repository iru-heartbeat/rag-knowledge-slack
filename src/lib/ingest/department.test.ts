import { describe, expect, it } from "vitest";
import { extractDepartments } from "./department";

const DEPTS = ["戦略", "業務", "IT", "人事", "営業", "管理"];
const doc = (text: string) => [{ title: null, text }];

describe("extractDepartments", () => {
  it.each([
    ["部署：営業部", "営業"],
    ["担当部署: 人事部", "人事"],
    ["作成部署　戦略部門", "戦略"],
    ["所属：ＩＴ部", "IT"], // 全角英字
    ["部署：it", "IT"], // 小文字
    ["部署：管理", "管理"], // 接尾辞なし
  ])("%s → %s", (text, expected) => {
    expect(extractDepartments(doc(text), DEPTS).departments).toEqual([expected]);
  });

  it("項目名と値が改行で分かれた表形式にも対応する", () => {
    expect(extractDepartments(doc("部署\n営業部"), DEPTS).departments).toEqual(["営業"]);
  });

  it("複数部署が書かれていれば全て返す", () => {
    expect(extractDepartments(doc("担当部署：営業部、人事部"), DEPTS).departments).toEqual(["営業", "人事"]);
    expect(extractDepartments(doc("部署：営業部および管理部"), DEPTS).departments).toEqual(["営業", "管理"]);
  });

  it("部分一致では許可しない（業務管理部は業務でも管理でもない）", () => {
    const r = extractDepartments(doc("部署：業務管理部"), DEPTS);
    expect(r.departments).toEqual([]);
    expect(r.unmatched).toEqual(["業務管理部"]);
  });

  it("宛先部署など別の語の一部は部署欄として扱わない", () => {
    expect(extractDepartments(doc("宛先部署：人事部"), DEPTS).departments).toEqual([]);
  });

  it("記載がなければ空（誰にも見せない扱い）", () => {
    expect(extractDepartments(doc("議事録\n本日の議題は…"), DEPTS)).toEqual({ departments: [], unmatched: [] });
  });

  it("本文中の普通の文は誤検出しない", () => {
    const r = extractDepartments(doc("部署の方針について、営業部と人事部が協議した。"), DEPTS);
    expect(r.departments).toEqual([]);
  });

  it("冒頭2000文字より後ろの記載は見ない", () => {
    const text = "あ".repeat(2100) + "\n部署：営業部";
    expect(extractDepartments(doc(text), DEPTS).departments).toEqual([]);
  });

  describe("登録名に区切り文字や接尾辞が含まれる場合（レビュー指摘）", () => {
    it("値全体で登録名と一致すれば分割せずに採用する", () => {
      const depts = ["人と組織開発", "経営企画・IR", "営業"];
      expect(extractDepartments(doc("部署：人と組織開発"), depts).departments).toEqual(["人と組織開発"]);
      expect(extractDepartments(doc("部署：経営企画・IR"), depts).departments).toEqual(["経営企画・IR"]);
    });

    it("登録名に「部」が付いていても、文書の「営業部」と一致する", () => {
      expect(extractDepartments(doc("部署：営業部"), ["営業部", "人事部"]).departments).toEqual(["営業部"]);
      expect(extractDepartments(doc("部署：営業"), ["営業部", "人事部"]).departments).toEqual(["営業部"]);
    });

    it("全体で一致しなければ、従来どおり区切って複数部署を拾う", () => {
      expect(extractDepartments(doc("部署：営業・人事"), DEPTS).departments).toEqual(["営業", "人事"]);
      expect(extractDepartments(doc("部署：営業部と人事部"), DEPTS).departments).toEqual(["営業", "人事"]);
    });
  });

  describe("書かれていない部署に権限を付けない（レビュー指摘）", () => {
    it("同じ行の別の項目（客先など）が部署名と同じ文字でも、部署として拾わない", () => {
      const r = extractDepartments(doc("部署: 戦略 / 客先: 管理 / 作成: 2024年"), DEPTS);
      expect(r.departments).toEqual(["戦略"]);
      expect(extractDepartments(doc("部署: 営業 / 客先: IT / 作成: 2024年"), DEPTS).departments).toEqual(["営業"]);
    });

    it("空白区切りの文（担当部署 営業 人事 が対応）からは権限を付けない", () => {
      const r = extractDepartments(doc("担当部署 営業 人事 が対応"), DEPTS);
      expect(r.departments).toEqual([]);
      expect(r.unmatched).toEqual(["営業 人事 が対応"]);
    });

    it("併記の一部だけが登録名のときは、全か無かで権限を付けない", () => {
      const r = extractDepartments(doc("部署：営業・存在しない"), DEPTS);
      expect(r.departments).toEqual([]);
      expect(r.unmatched).toEqual(["営業・存在しない"]);
    });

    it("先頭15行より後ろの記載は見ない", () => {
      const filler = Array.from({ length: 15 }, (_, i) => `行${i + 1}`).join("\n");
      expect(extractDepartments(doc(`${filler}\n部署：営業`), DEPTS).departments).toEqual([]);
      expect(extractDepartments(doc(`${filler.split("\n").slice(0, 14).join("\n")}\n部署：営業`), DEPTS).departments).toEqual(["営業"]);
    });
  });

  describe("部署欄が複数あって食い違うときは、権限を付けない（レビュー指摘: 合算すると権限の付けすぎになる）", () => {
    it("表紙の「部署: 戦略」と、別の行の「担当部署: 人事」が違えば、どちらにも権限を付けず、管理者の確認に回す", () => {
      const r = extractDepartments(doc("提案書\n部署: 戦略 / 客先: A社\n体制\n担当部署: 人事"), DEPTS);
      expect(r.departments).toEqual([]);
      expect(r.unmatched.sort()).toEqual(["人事", "戦略"]);
    });

    it("1つが登録名に一致し、もう1つが一致しないときも、一致した方だけに権限を付けない", () => {
      const r = extractDepartments(doc("部署：営業\n所属：存在しない部"), DEPTS);
      expect(r.departments).toEqual([]);
      expect(r.unmatched.sort()).toEqual(["営業", "存在しない部"]);
    });

    it("同じ内容を複数の場所に書いているだけなら、そのまま採用する", () => {
      expect(extractDepartments(doc("部署: 戦略\n担当部署：戦略部"), DEPTS).departments).toEqual(["戦略"]);
    });

    it("併記の順番が違うだけで同じ集合なら、採用する", () => {
      const r = extractDepartments(doc("部署: 営業・人事\n担当部署：人事、営業"), DEPTS);
      expect(r.departments.sort()).toEqual(["人事", "営業"]);
    });
  });

  it("見出し(title)側に書かれた部署も拾う", () => {
    const r = extractDepartments([{ title: "部署：営業部", text: "本文" }], DEPTS);
    expect(r.departments).toEqual(["営業"]);
  });
});
