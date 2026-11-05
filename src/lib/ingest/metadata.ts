import type { Section } from "./chunk";
import { documentHead } from "./head";
import { BEFORE, VALUE } from "./labeled";

export type DocMetadata = {
  /** 客先名。記載がなければ null */
  customer: string | null;
  /** 年月日が分かる場合のみ "YYYY-MM-DD"。年月だけ・年だけの場合は null */
  docDate: string | null;
  /** 作成年。年月日が分かる場合はその年。記載がなければ null */
  docYear: number | null;
};

// 項目名の直前が漢字・英字なら別の語の一部（例: 主要客先）なので対象外。
// 項目名の直後はコロンか空白が必須（普通の文章を拾わないため）。
const SEP = String.raw`([ \t　]*:[ \t　]*|[ \t　]+)`; // 捕捉して、コロン区切りか空白だけの区切りかを後で見分ける

const CUSTOMER = new RegExp(`${BEFORE}(?:客先|顧客|取引先|クライアント)名?${SEP}${VALUE(60)}`, "g");
const DATE_LABEL = new RegExp(`${BEFORE}(?:作成年月日|作成日|作成|発行日|発行|日付)${SEP}${VALUE(40)}`, "g");

// 年月日 → 年 の順に最も詳しいものを採用（月だけ・年月だけは年として扱う）。
// 年は前後が数字でない4桁だけ（「12345」の先頭4桁を年として拾わない）
const FULL_DATE = /(?<!\d)(\d{4})\s*(?:年|[/.\-])\s*(\d{1,2})\s*(?:月|[/.\-])\s*(\d{1,2})(?!\d)\s*日?/;
const YEAR = /(?<!\d)(\d{4})(?!\d)\s*年?/;

// DB の documents.doc_year の制約（1900〜2100）と同じ範囲。範囲外を渡すと文書ごと保存に失敗する
const MIN_YEAR = 1900;
const MAX_YEAR = 2100;
const isValidYear = (y: number) => y >= MIN_YEAR && y <= MAX_YEAR;

export function extractMetadata(sections: Section[]): DocMetadata {
  const head = documentHead(sections);
  return { customer: extractCustomer(head), ...extractDate(head) };
}

/**
 * 項目名の一致を、確度の高い層に分ける。
 *  1層目: 「客先: A社」のようなコロン区切り（項目として書かれている可能性が高い）
 *  2層目: 「顧客 向け提案書」のように空白だけで続くもの（普通の文の可能性がある）
 * 先頭の一致だけを見ると、表紙の文に出た語を拾って本来の欄を見逃すため。
 */
function tiersByConfidence(matches: Iterable<RegExpMatchArray>): RegExpMatchArray[][] {
  const all = [...matches];
  return [all.filter((m) => m[1].includes(":")), all.filter((m) => !m[1].includes(":"))];
}

function extractCustomer(head: string): string | null {
  for (const m of tiersByConfidence(head.matchAll(CUSTOMER)).flat()) {
    const value = m[2].trim();
    if (value) return value;
  }
  return null;
}

function extractDate(head: string): Pick<DocMetadata, "docDate" | "docYear"> {
  // 上の層で年か日付が1つでも見つかれば確定し、下の層は見ない。
  // 下の層まで混ぜると、コロン付きの正しい欄（作成: 2023年）を、後ろの文中の日付（発行 2024/3/5 以降は…）が上書きする
  for (const tier of tiersByConfidence(head.matchAll(DATE_LABEL))) {
    const found = dateFromMatches(tier);
    if (found.docDate !== null || found.docYear !== null) return found;
  }
  return { docDate: null, docYear: null };
}

function dateFromMatches(matches: RegExpMatchArray[]): Pick<DocMetadata, "docDate" | "docYear"> {
  let yearOnly: number | null = null;
  for (const m of matches) {
    const value = m[2];
    const full = value.match(FULL_DATE);
    if (full) {
      const iso = toIsoDate(Number(full[1]), Number(full[2]), Number(full[3]));
      if (iso) return { docDate: iso, docYear: Number(full[1]) };
    }
    const year = value.match(YEAR);
    if (year && yearOnly === null && isValidYear(Number(year[1]))) yearOnly = Number(year[1]);
  }
  return { docDate: null, docYear: yearOnly };
}

/** 実在しない日付（2月30日など）や、年が範囲外のものは null */
function toIsoDate(y: number, m: number, d: number): string | null {
  if (!isValidYear(y)) return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}
