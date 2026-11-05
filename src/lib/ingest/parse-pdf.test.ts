import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { extractDepartments } from "./department";
import { headingLevel, NoTextError, pagesToSections, parsePdf } from "./parse-pdf";

describe("headingLevel", () => {
  it.each([
    ["第1章 総則", 1],
    ["第2節 範囲", 2],
    ["1. 概要", 1],
    ["2.1 目的", 2],
    ["3.2.1 詳細", 3],
    ["■ 背景", 1],
    ["【注意事項】", 1],
  ])("%s は見出し(レベル%i)", (line, level) => {
    expect(headingLevel(line)).toBe(level);
  });

  it.each([
    ["3 名で対応"], // 数字+空白+助数詞（レビュー指摘）
    ["10 月 5 日に打合せ"],
    ["5 台のサーバを移行"],
    ["1.5 倍に増加"], // ドット付きでも助数詞が続けば本文
    ["本件は2024年に開始した。"],
    ["これは普通の文章で、句点で終わります。"],
    ["2024年度の実績"],
    ["あ".repeat(50)],
    ["通常の行"],
  ])("%s は見出しではない", (line) => {
    expect(headingLevel(line)).toBe(0);
  });
});

describe("pagesToSections", () => {
  it("見出しごとに分かれ、階層が「親 > 子」になる", () => {
    const sections = pagesToSections([
      "1. 概要\nこのプロジェクトは社内の知識共有を目的とする。\n1.1 背景\n検索に時間がかかっていた。",
      "2. 方針\nベクトル検索を採用する。この文章は十分な長さがある。",
    ]);
    expect(sections.map((s) => s.title)).toEqual(["1. 概要", "1. 概要 > 1.1 背景", "2. 方針"]);
    expect(sections[1].text).toBe("検索に時間がかかっていた。");
  });

  it("折り返された日本語の行はつなぎ、文末で段落を分ける", () => {
    const [s] = pagesToSections([
      "1. 概要\n本システムは文書を検索するための仕組みであり社内知識の共有を目的と\nする。\n次の文もここにある。",
    ]);
    expect(s.text).toBe(
      "本システムは文書を検索するための仕組みであり社内知識の共有を目的とする。\n\n次の文もここにある。",
    );
  });

  it("句点のない箇条書き（幅いっぱいでない行）は別々の段落になる", () => {
    const [s] = pagesToSections([
      "2. 課題\n短い項目その一\n短い項目その二\nこれは長い行でページ幅いっぱいまで書かれているテキストであり折り返す\nされて続きがここに来る。",
    ]);
    expect(s.text.split("\n\n")).toEqual([
      "短い項目その一",
      "短い項目その二",
      "これは長い行でページ幅いっぱいまで書かれているテキストであり折り返すされて続きがここに来る。",
    ]);
  });

  it("ページ番号と、全ページ共通のヘッダーは除去する（5ページ以上）", () => {
    const pages = ["その一", "その二", "その三", "その四", "その五"].map(
      // 実際のページと同様に、ヘッダー・本文複数行・ページ番号の5行（4行以下のページは端の判定をしない）
      (n, i) =>
        `社外秘 報告書\n本文${n}。これは長めの本文です。\n追加の本文${n}。これも長めの文章です。\n続きの本文${n}。さらに続く文です。\n- ${i + 1} -`,
    );
    const text = pagesToSections(pages).map((s) => s.text).join("\n");
    expect(text).not.toContain("社外秘");
    expect(text).not.toMatch(/- \d -/);
    expect(text).toContain("本文その二");
  });

  describe("本文を誤って消さない（レビュー指摘）", () => {
    it("4ページ以下では、複数ページに出る行をヘッダー扱いで消さない", () => {
      const pages = [
        "1. 概要\n本文その一。これは長めの本文です。\n備考",
        "備考\n本文その二。これは長めの本文です。\n以上の内容です。",
        "本文その三。これは長めの本文です。追加の文章。",
      ];
      const text = pagesToSections(pages).map((s) => s.text).join("\n");
      expect(text.match(/備考/g)).toHaveLength(2);
    });

    it("5ページ以上でも、ページの端ではない位置にある繰り返し行は消さない", () => {
      const page = (n: number) =>
        `ヘッダー${n}\n本文その${n}。これは長めの本文です。\n備考\n追加の本文その${n}。これも長めです。\nフッター${n}`;
      const text = pagesToSections([1, 2, 3, 4, 5].map(page)).map((s) => s.text).join("\n");
      expect(text.match(/備考/g)).toHaveLength(5);
    });

    describe("短いページと、ページ番号と無関係な数字（2回目のレビュー指摘）", () => {
      const BODY = "売上と費用の合計金額は次の表のとおりです。詳細は別表を参照のこと。";

      it("4行以下のページでは、末尾の数字（金額・年）をページ番号扱いで消さない", () => {
        const [s] = pagesToSections([`1. 実績\n${BODY}\n100\n2024`]);
        expect(s.text).toContain("100");
        expect(s.text).toContain("2024");
      });

      it("ページ番号と一致しない裸の数字は、先頭・末尾の行でも残す", () => {
        const [s] = pagesToSections([`1. 実績\n${BODY}\n追加の説明文をここに置きます。\n3`]);
        expect(s.text).toContain("3");
      });

      it("ページ番号と一致する裸の数字は、ページの末尾なら消す", () => {
        const sections = pagesToSections([`1. 実績\n${BODY}\n1`, `${BODY}\n2`]);
        const text = sections.map((s) => s.text).join("\n");
        expect(text).not.toMatch(/(^|\n)[12](\n|$)/);
      });

      it("装飾付きのページ番号（- 2 -、3 / 10）は、短いページでも消す", () => {
        const text = pagesToSections([`1. 実績\n${BODY}\n- 1 -`, `${BODY}\n2 / 10`])
          .map((s) => s.text)
          .join("\n");
        expect(text).not.toMatch(/- 1 -|2 \/ 10/);
      });

      it("5ページ以上でも、4行以下の短いページでは繰り返し行を消さない", () => {
        const pages = [1, 2, 3, 4, 5].map((n) => `社外秘\n本文その${n}。これは長めの本文です。\n続きの文章その${n}もあります。\n以上`);
        const text = pagesToSections(pages).map((s) => s.text).join("\n");
        expect(text.match(/社外秘/g)).toHaveLength(5);
      });
    });

    it("本文中の数字だけの行（年・数量）は残し、ページ末尾の番号だけ消す", () => {
      const [s] = pagesToSections([
        "1. 実績\n売上は次のとおりです。\n2024\n100\n増加傾向にあります。\n追加の説明文をここに置く。\n- 1 -",
      ]);
      expect(s.text).toContain("2024");
      expect(s.text).toContain("100");
      expect(s.text).not.toContain("- 1 -");
    });
  });

  it("テキストがほぼ無い場合は NoTextError", () => {
    expect(() => pagesToSections(["", "  \n "])).toThrow(NoTextError);
  });
});

/** 最小構成の本物の PDF（英字のみ）を組み立てる。textLines が空なら文字なしのページ */
function buildPdf(textLines: string[]): Buffer {
  const stream = textLines.length
    ? `BT /F1 12 Tf 14 TL 50 700 Td ${textLines.map((l) => `(${l}) Tj T*`).join(" ")} ET`
    : "";
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf, "latin1");
}

describe("parsePdf（本物のPDF）", () => {
  it("PDFから文字を取り出して見出しで分ける", async () => {
    const buf = buildPdf(["1. Overview", "This system searches company documents quickly.", "2. Policy", "We use vector search for retrieval."]);
    const sections = await parsePdf(buf);
    expect(sections.map((s) => s.title)).toEqual(["1. Overview", "2. Policy"]);
    expect(sections[0].text).toContain("searches company documents");
  });

  it("文字のないPDFは NoTextError", async () => {
    await expect(parsePdf(buildPdf([]))).rejects.toThrow(NoTextError);
  });
});

// 実際のサンプル文書（案件提供）。フォルダが無い環境ではスキップ
const SAMPLE_DIR = join(__dirname, "../../../テスト用PDF_元ファイル");
const DEPTS = ["戦略", "業務", "IT", "人事", "営業", "管理"];

describe.skipIf(!existsSync(SAMPLE_DIR))("サンプルPDF（実データ）", () => {
  const load = (name: string) => parsePdf(readFileSync(join(SAMPLE_DIR, name)));

  it("見出し5つに分かれ、箇条書きは別々の段落になる", async () => {
    const sections = await load("case7-doc1-strategy-dx-bank.pdf");
    expect(sections.map((s) => s.title)).toEqual([
      null,
      "1. 案件概要",
      "2. 現状の課題",
      "3. アプローチ",
      "4. ROI 試算",
      "5. 想定スケジュール・体制",
    ]);
    expect(sections[2].text.split("\n\n")).toHaveLength(3);
  });

  it("部首などの別文字がNFKCで通常の漢字に統一される", async () => {
    const text = (await load("case7-doc2-hr-engagement-report.pdf")).map((s) => s.text).join("");
    expect(text).toContain("従業員");
    expect(text).not.toContain("⼈"); // ⼈(康熙部首)
  });

  it.each([
    ["case7-doc1-strategy-dx-bank.pdf", "戦略"],
    ["case7-doc2-hr-engagement-report.pdf", "人事"],
    ["case7-doc3-it-cloud-migration.pdf", "IT"],
    ["case7-doc4-sales-proposal-retail.pdf", "営業"],
  ])("%s の部署は %s と判定される", async (file, dept) => {
    const r = extractDepartments(await load(file), DEPTS);
    expect(r.departments).toEqual([dept]);
  });
});
