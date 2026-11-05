import { extractText, getDocumentProxy } from "unpdf";
import type { Section } from "./chunk";
import { SectionBuilder } from "./section-builder";

/** 文字が取り出せない PDF（スキャン画像のみ等）。OCR は対象外なので取り込み不可として記録する。 */
export class NoTextError extends Error {
  constructor() {
    super("PDFからテキストを取り出せませんでした（スキャン画像のみの可能性。OCRは対象外）");
    this.name = "NoTextError";
  }
}

const MIN_TOTAL_CHARS = 30;

export async function parsePdf(buffer: Buffer): Promise<Section[]> {
  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  const { text } = await extractText(pdf, { mergePages: false });
  // PDF は「⼈」(部首) など見た目が同じ別文字を使うことがある。NFKC で通常の文字に統一しないと検索にヒットしない
  return pagesToSections(text.map((t) => t.normalize("NFKC")));
}

// 折り返し行の判定: ページ内で最長の行の幅に対してこの割合以上なら「折り返された途中の行」とみなす
const WRAP_RATIO = 0.9;
const SENTENCE_END = /[。．！？!?]$/;
// 数量・日付の単位。「人」「社」は「人材」「社会」など見出し語の頭にもなるため含めない
const QUANTITY_UNIT = /^[名台件月日年円回倍割%％]/;

/** ページごとのテキストから「見出し + 本文」を組み立てる（単体テスト可能な純粋関数） */
export function pagesToSections(pages: string[]): Section[] {
  const total = pages.join("").replace(/\s/g, "").length;
  if (total < MIN_TOTAL_CHARS) throw new NoTextError();

  const pageLines = pages.map((p) =>
    p
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean),
  );
  const noise = findRepeatedEdgeLines(pageLines);

  const builder = new SectionBuilder();
  let buf = "";
  const flushParagraph = () => {
    builder.paragraph(buf.trim());
    buf = "";
  };

  for (const [pageIndex, lines] of pageLines.entries()) {
    // ページ番号・ヘッダー/フッターは「ページの端」にしかない。本文中の「2024」「備考」などを消さないよう端の行だけ対象にする
    const body = lines.filter(
      (l, i) =>
        !(isPageNumber(l, i, lines.length, pageIndex + 1) || (isEdgeLine(i, lines.length) && noise.has(l))),
    );
    // 箇条書きは句点がなく、PDF では記号も残らない。幅いっぱいでない行は「そこで段落が終わる」とみなす
    const maxWidth = Math.max(0, ...body.filter((l) => !headingLevel(l)).map(displayWidth));
    for (const line of body) {
      const level = headingLevel(line);
      if (level) {
        flushParagraph();
        builder.heading(level, line);
        continue;
      }
      buf = joinLines(buf, line);
      if (SENTENCE_END.test(line) || displayWidth(line) < maxWidth * WRAP_RATIO) flushParagraph();
    }
  }
  flushParagraph();
  return builder.build();
}

/**
 * 見出しらしさの判定。PDF には見出し情報がないため、行の見た目から推測する。
 * 該当すれば階層レベル(1〜)、違えば 0。
 */
export function headingLevel(line: string): number {
  if (line.length > 40 || /[。、，,．]$/.test(line)) return 0;

  const chapter = line.match(/^第\s*[0-9０-９一二三四五六七八九十百]+\s*([章節条項])/);
  if (chapter) return { 章: 1, 節: 2, 条: 3, 項: 4 }[chapter[1] as "章" | "節" | "条" | "項"];

  // 「1. 概要」「2.1 目的」のような番号付き見出し。ドットの数で階層を決める
  const numbered = line.match(/^(\d{1,2}(?:[.．]\d{1,2})*)([.．、)）]|\s)\s*(\S.*)$/);
  if (numbered) {
    const [, num, sep, rest] = numbered;
    if (/\s/.test(sep)) {
      // 空白だけで区切られた「3 名で対応」「10 月 5 日…」は本文。番号に小数点も無ければ見出しとみなさない
      if (!/[.．]/.test(num)) return 0;
      // 「1.5 倍に増加」のように数量の単位が続くものも本文
      if (QUANTITY_UNIT.test(rest)) return 0;
    }
    return num.split(/[.．]/).length;
  }

  if (/^[■□●◆▼【]/.test(line)) return 1;
  return 0;
}

/**
 * ページ番号か。ページの最初か最後の行にあり、かつ次のどちらかのときだけ。
 *  - 「- 3 -」「3 / 10」のような装飾付き
 *  - 裸の数字で、そのページの番号と一致する（ページ1の末尾の「1」）
 * 表やグラフの単独行にある「100」「2024」は本文なので消さない。
 */
function isPageNumber(line: string, index: number, total: number, pageNo: number): boolean {
  if (index !== 0 && index !== total - 1) return false;
  if (/^[-‐–—]\s*\d{1,4}\s*[-‐–—]$/.test(line) || /^\d{1,4}\s*\/\s*\d{1,4}$/.test(line)) return true;
  return /^\d{1,4}$/.test(line) && Number(line) === pageNo;
}

const EDGE_LINES = 2; // ページの先頭・末尾から何行をヘッダー/フッターの候補にするか
const MIN_PAGES_FOR_NOISE = 5; // ページ数が少ないと「繰り返し」かどうか判断できないため、これ未満では除去しない

// 行数が少ないページは、全ての行が「端」になってしまい本文を消しかねないので、端の判定をしない
function isEdgeLine(index: number, total: number): boolean {
  return total > EDGE_LINES * 2 && (index < EDGE_LINES || index >= total - EDGE_LINES);
}

/** ページの端に繰り返し出る行（ヘッダー・フッター）を集める。5ページ以上で、半数以上のページの端に出るもの */
function findRepeatedEdgeLines(pageLines: string[][]): Set<string> {
  const result = new Set<string>();
  if (pageLines.length < MIN_PAGES_FOR_NOISE) return result;
  const counts = new Map<string, number>();
  for (const lines of pageLines) {
    const edge = lines.filter((_, i) => isEdgeLine(i, lines.length));
    for (const l of new Set(edge)) counts.set(l, (counts.get(l) ?? 0) + 1);
  }
  for (const [l, n] of counts) if (n >= pageLines.length / 2) result.add(l);
  return result;
}

/** 表示幅の目安。全角=1、半角=0.5（折り返し判定用） */
function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += ch.charCodeAt(0) <= 0x7f ? 0.5 : 1;
  return w;
}

/** 折り返された行をつなぐ。日本語は詰め、英単語同士のときだけ空白を入れる */
function joinLines(prev: string, next: string): string {
  if (!prev) return next;
  return /[A-Za-z0-9,]$/.test(prev) && /^[A-Za-z0-9]/.test(next) ? `${prev} ${next}` : prev + next;
}
