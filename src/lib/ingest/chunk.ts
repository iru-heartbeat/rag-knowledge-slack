import { config } from "../config";

/** パーサーが返す「見出し + 本文」の単位 */
export type Section = { title: string | null; text: string };

/** DB の chunks に入れる単位 */
export type Chunk = {
  sectionTitle: string | null;
  sectionOrder: number; // 文書内の通し番号（0始まり）
  content: string;
};

type Options = { maxChars: number; overlapChars: number };

const defaults: Options = {
  maxChars: config.chunk.maxChars,
  overlapChars: config.chunk.overlapChars,
};

/**
 * セクション単位で分割し、長すぎるセクションだけ上限文字数で再分割する。
 * 検索精度のため、各チャンクの先頭に見出しを付ける（見出しは文脈の手がかりになる）。
 */
export function chunkSections(sections: Section[], opts: Partial<Options> = {}): Chunk[] {
  const { maxChars, overlapChars } = { ...defaults, ...opts };
  if (overlapChars >= maxChars) throw new Error("overlapChars は maxChars より小さくしてください");

  const chunks: Chunk[] = [];
  for (const section of sections) {
    const text = section.text.trim();
    if (!text) continue;
    // 内容の先頭に付ける見出しの分だけ、本文の上限を減らす（付けた後の全体が maxChars を超えないように）。
    // 下限は、overlap を引いた後に本文が残る長さ
    const prefix = section.title ? shortenTitle(section.title) : "";
    const bodyMax = Math.max(maxChars - (prefix ? prefix.length + 1 : 0), overlapChars + MIN_BODY_CHARS);
    for (const piece of splitText(text, bodyMax, overlapChars)) {
      chunks.push({
        sectionTitle: section.title, // DB 保存用は省略しない
        sectionOrder: chunks.length,
        content: prefix ? `${prefix}\n${piece}` : piece,
      });
    }
  }
  return chunks;
}

const MAX_TITLE_PREFIX = 80; // 内容の先頭に付ける見出しの最大文字数
const MIN_BODY_CHARS = 50; // 見出しが長くても、本文に最低限確保する文字数

/** 長い見出しは、より具体的な末尾（「親 > 子 > 孫」の孫側）を残して短くする */
function shortenTitle(title: string): string {
  const chars = Array.from(title);
  if (chars.length <= MAX_TITLE_PREFIX) return title;
  return "…" + chars.slice(-(MAX_TITLE_PREFIX - 1)).join("");
}

/**
 * トークン数の目安（正確な値ではない）。日本語など全角は1文字≒1トークン、半角英数は4文字≒1トークンで数える。
 * プロンプトに入れる量の見積もりや統計用。正確に数える必要が出たら、使うモデルのトークナイザに置き換える。
 */
export function estimateTokens(text: string): number {
  let tokens = 0;
  for (const ch of text) tokens += ch.charCodeAt(0) <= 0x7f ? 0.25 : 1;
  return Math.ceil(tokens);
}

/** 段落 → 文 → 文字数 の順に、自然な切れ目を優先して分割する */
export function splitText(text: string, maxChars: number, overlapChars: number): string[] {
  if (text.length <= maxChars) return [text];

  // 重なり(overlap)分を先頭に足しても maxChars を超えないよう、本体の上限を減らす
  const bodyMax = maxChars - overlapChars;

  const units: string[] = [];
  for (const paragraph of text.split(/\n{2,}/)) {
    if (paragraph.length <= bodyMax) {
      units.push(paragraph);
      continue;
    }
    for (const sentence of paragraph.split(/(?<=[。．！？!?\n])/)) {
      if (sentence.length <= bodyMax) {
        units.push(sentence);
      } else {
        // 文字数で強制的に切る。string.slice は UTF-16 単位で、「𠮷」や絵文字（2単位で1文字）を
        // 途中で割って壊すことがあるため、1文字ずつの配列（Array.from）にしてから切る
        const chars = Array.from(sentence);
        for (let i = 0; i < chars.length; i += bodyMax) {
          units.push(chars.slice(i, i + bodyMax).join(""));
        }
      }
    }
  }

  // 上限に収まる範囲で単位を詰める
  const bodies: string[] = [];
  let current = "";
  for (const unit of units) {
    if (current && current.length + unit.length + 1 > bodyMax) {
      bodies.push(current);
      current = unit;
    } else {
      current = current ? `${current}\n${unit}` : unit;
    }
  }
  if (current) bodies.push(current);

  // 2つ目以降は、直前チャンクの末尾を重ねて文脈の途切れを防ぐ
  // （末尾の切り出しも、文字を割らないよう Array.from で行う）
  return bodies.map((body, i) =>
    i === 0 || overlapChars === 0 ? body : Array.from(bodies[i - 1]).slice(-overlapChars).join("") + body,
  );
}
