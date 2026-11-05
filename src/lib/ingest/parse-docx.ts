import mammoth from "mammoth";
import type { Section } from "./chunk";
import { SectionBuilder } from "./section-builder";

/**
 * Word(.docx) から「見出し + 本文」のセクション一覧を取り出す。
 * mammoth で docx を単純な HTML に変換し、見出しタグ(h1〜h6)で区切る。
 */
export async function parseDocx(buffer: Buffer): Promise<Section[]> {
  return htmlToSections(await convertDocxToHtml(buffer));
}

/** docx → HTML 変換（テストで画像の扱いを確認できるよう切り出している） */
export async function convertDocxToHtml(buffer: Buffer): Promise<string> {
  // 既定では画像を base64 の巨大な文字列として HTML に埋め込む。画像は OCR 対象外で使わないので、中身を空にして捨てる
  const dropImages = mammoth.images.imgElement(async () => ({ src: "" }));
  const { value } = await mammoth.convertToHtml({ buffer }, { convertImage: dropImages });
  return value;
}

// ブロックの区切りと見出しの目印に使う制御文字（本文には現れないので、念のため入力から取り除いて使う）
const SEP = "\u0001";
const BLOCK_TAGS = /<\/?(?:h[1-6]|p|li|ul|ol|table|thead|tbody|tfoot|tr|td|th|div|blockquote)\b[^>]*>/gi;

/**
 * mammoth が出力する HTML を見出し単位のセクションに分ける（単体テスト可能な純粋関数）。
 *
 * 「<li>…</li>」のように開始〜終了タグを対で探す方式だと、入れ子の箇条書き
 * （<li>A<ul><li>B</li></ul></li>）で外側の終了位置を取り違えて親子が結合してしまう。
 * そこで、ブロック系タグは開始・終了を問わず全て区切り文字に置き換え、区切りごとに分けて処理する。
 */
export function htmlToSections(html: string): Section[] {
  const marked = html
    .replace(/[\u0001-\u0003]/g, "")
    .replace(/<h([1-6])\b[^>]*>/gi, `${SEP}\u0002$1\u0003`) // 見出しの開始タグだけレベル付きの目印にする
    .replace(BLOCK_TAGS, SEP);

  const builder = new SectionBuilder();
  for (const piece of marked.split(SEP)) {
    const heading = piece.match(/^\u0002([1-6])\u0003([\s\S]*)$/);
    if (heading) builder.heading(Number(heading[1]), htmlToText(heading[2]));
    else builder.paragraph(htmlToText(piece));
  }
  return builder.build();
}

function htmlToText(fragment: string): string {
  return decodeEntities(
    fragment
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, "")
  ).trim();
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, "&"); // 二重デコードを避けるため最後に処理
}
