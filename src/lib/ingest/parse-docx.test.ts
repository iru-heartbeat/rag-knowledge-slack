import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { convertDocxToHtml, htmlToSections, parseDocx } from "./parse-docx";

describe("htmlToSections", () => {
  it("見出しごとにセクションが分かれる", () => {
    const html = "<h1>概要</h1><p>はじめに</p><h1>仕様</h1><p>詳細A</p><p>詳細B</p>";
    expect(htmlToSections(html)).toEqual([
      { title: "概要", text: "はじめに" },
      { title: "仕様", text: "詳細A\n\n詳細B" },
    ]);
  });

  it("見出しの前の本文は title: null になる", () => {
    const s = htmlToSections("<p>前書き</p><h1>本編</h1><p>本文</p>");
    expect(s[0]).toEqual({ title: null, text: "前書き" });
  });

  it("見出し階層が「親 > 子」のタイトルになり、兄弟に移るとリセットされる", () => {
    const html = "<h1>A</h1><h2>A-1</h2><p>x</p><h2>A-2</h2><p>y</p><h1>B</h1><p>z</p>";
    expect(htmlToSections(html).map((s) => s.title)).toEqual(["A > A-1", "A > A-2", "B"]);
  });

  it("タグ除去・HTMLエンティティのデコード・<br>の改行", () => {
    const [s] = htmlToSections("<p><strong>R&amp;D</strong> &lt;試験&gt;<br />二行目</p>");
    expect(s.text).toBe("R&D <試験>\n二行目");
  });

  it("リスト項目も本文として取り込む", () => {
    const [s] = htmlToSections("<h1>手順</h1><ul><li>一つ目</li><li>二つ目</li></ul>");
    expect(s.text).toBe("一つ目\n\n二つ目");
  });

  it("入れ子の箇条書きは親子を結合せず別々の段落にする（レビュー指摘）", () => {
    const html = "<h1>手順</h1><ul><li>A<ul><li>B</li><li>C</li></ul></li><li>D</li></ul>";
    expect(htmlToSections(html)).toEqual([{ title: "手順", text: "A\n\nB\n\nC\n\nD" }]);
  });

  it("表のセルも別々の段落になる", () => {
    const html = "<h1>表</h1><table><tr><td><p>項目</p></td><td><p>値</p></td></tr></table>";
    expect(htmlToSections(html)).toEqual([{ title: "表", text: "項目\n\n値" }]);
  });

  it("見出しの中の装飾タグ（太字など）は取り除く", () => {
    expect(htmlToSections("<h1><strong>概要</strong></h1><p>本文</p>")).toEqual([
      { title: "概要", text: "本文" },
    ]);
  });

  it("本文のない見出しだけの文書は空配列", () => {
    expect(htmlToSections("<h1>見出しだけ</h1>")).toEqual([]);
  });
});

/** 最小構成の本物の .docx を組み立てる。image を渡すと PNG 画像を埋め込めるようにする */
async function buildDocx(bodyXml: string, image?: Buffer): Promise<Buffer> {
  const zip = new JSZip();
  if (image) zip.file("word/media/image1.png", image);
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="png" ContentType="image/png"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`,
  );
  zip.file(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
  );
  zip.file(
    "word/_rels/document.xml.rels",
    `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/></Relationships>`,
  );
  zip.file(
    "word/styles.xml",
    `<?xml version="1.0" encoding="UTF-8"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/></w:style></w:styles>`,
  );
  zip.file(
    "word/document.xml",
    `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${bodyXml}</w:body></w:document>`,
  );
  return zip.generateAsync({ type: "nodebuffer" });
}

const para = (text: string, style?: string) =>
  `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ""}<w:r><w:t>${text}</w:t></w:r></w:p>`;

describe("parseDocx（本物のdocx）", () => {
  it("見出しスタイルを認識して日本語のセクションに分ける", async () => {
    const buf = await buildDocx(
      para("プロジェクト報告", "Heading1") +
        para("概要の本文です。") +
        para("課題", "Heading2") +
        para("納期が厳しい。"),
    );
    expect(await parseDocx(buf)).toEqual([
      { title: "プロジェクト報告", text: "概要の本文です。" },
      { title: "プロジェクト報告 > 課題", text: "納期が厳しい。" },
    ]);
  });

  describe("画像入りのWord（レビュー指摘）", () => {
    // 1x1 の PNG。実物の大きな画像の代わりに、画像が HTML に埋め込まれるかどうかだけを見る
    const PNG = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    );
    const imageParagraph = `<w:p><w:r><w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><wp:extent cx="100" cy="100"/><wp:docPr id="1" name="img"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:blipFill><a:blip xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:embed="rId2"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;

    it("画像データ(base64)をHTMLに埋め込まない", async () => {
      const buf = await buildDocx(para("図の説明", "Heading1") + imageParagraph + para("本文です。"), PNG);
      expect(await convertDocxToHtml(buf)).not.toContain("data:image");
    });

    it("画像があっても本文は取り出せる", async () => {
      const buf = await buildDocx(para("図の説明", "Heading1") + imageParagraph + para("本文です。"), PNG);
      expect(await parseDocx(buf)).toEqual([{ title: "図の説明", text: "本文です。" }]);
    });
  });
});
