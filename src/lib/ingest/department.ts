import type { Section } from "./chunk";
import { documentHead } from "./head";
import { BEFORE, VALUE } from "./labeled";

export type DepartmentResult = {
  /** 登録済み部署名のうち、文書に記載があったもの（重複なし） */
  departments: string[];
  /** 部署欄らしき記載はあったが、登録部署と一致しなかった値（管理者の確認用） */
  unmatched: string[];
};

// 表紙の記載を探す範囲。本文中の「担当部署 営業…」のような文を拾わないよう、先頭の数行に限る
const HEADER_LINES = 15;

// 「部署」「担当部署」「作成部署」「所属」などの項目名。
// 直前が漢字・英字だと別の語の一部（例: 宛先部署）なので対象外にする。
// 項目名の直後は「コロン」か「空白・改行」が必須（「部署の方針について…」のような文章を除外するため）。
// 値は客先・日付と同じ切り方（" / " の手前まで）。切り方が違うと、隣の「客先: 管理」まで部署として読んでしまう
const LABEL = new RegExp(
  String.raw`${BEFORE}(?:担当|作成|発行|主管|起案)?(?:部署|部門|所属)名?(?:[ \t　]*:[ \t　]*\n?[ \t　]*|[ \t　]*\n[ \t　]*|[ \t　]+)` +
    VALUE(60),
  "g",
);

const SUFFIX = /(?:本部|部門|部|グループ|チーム|課|室)$/;

// 複数部署を併記するときの区切り。空白では区切らない（「営業 人事 が対応」のような文を部署の併記と誤読しないため）
const LIST_DELIMITER = /[、,，/／・]|および|及び|と/;

/**
 * 文書の冒頭から部署名を探す。一致しなければ departments は空（=誰にも見せない扱いにする）。
 * 権限に直結するため、少しでも曖昧なら権限は付けず、unmatched に残して管理者の確認に回す。
 */
export function extractDepartments(
  sections: Section[],
  knownDepartments: string[],
): DepartmentResult {
  const head = documentHead(sections)
    .split("\n")
    .filter((l) => l.trim())
    .slice(0, HEADER_LINES)
    .join("\n");

  // 登録名側にも同じ正規化（接尾辞除去を含む）をかけ、「営業部」登録でも文書の「営業部」「営業」に一致させる
  const known = new Map(knownDepartments.map((d) => [key(d), d]));
  // 部署欄ごとの読み取り結果。一致した部署の集合、または一致しなかった（null）
  const entries: Array<{ value: string; depts: string[] | null }> = [];

  for (const m of head.matchAll(LABEL)) {
    const value = m[1].trim();
    entries.push({ value, depts: resolve(value, known) });
  }

  // 部署欄が複数あるときは、全てが一致し、しかも同じ部署の集合のときだけ採用する。
  // 表紙の「部署: 戦略」に、別の行の「担当部署: 人事」を足し合わせると、書かれていない部署に権限を付けてしまう。
  // 食い違い・一部の不一致は「判定不能」として、権限は付けず管理者の確認に回す
  const all = entries.map((e) => e.depts);
  const resolved = all.filter((d): d is string[] => d !== null);
  const consistent =
    resolved.length === entries.length && resolved.every((d) => sameSet(d, resolved[0]));
  if (entries.length === 0 || !consistent) {
    return { departments: [], unmatched: [...new Set(entries.map((e) => e.value))] };
  }
  return { departments: [...new Set(resolved[0])], unmatched: [] };
}

/** 部署欄の値1つを、登録部署に照合する。一致しなければ null */
function resolve(value: string, known: Map<string, string>): string[] | null {
  // ① 値全体で一致するならそれを採用する。
  //    先に分割すると、「人と組織開発」「経営企画・IR」のように区切り文字を含む登録名が壊れるため
  const whole = known.get(key(value));
  if (whole) return [whole];

  // ② 一致しなければ区切って、複数部署の併記（「営業・人事」など）として照合する。
  //    全ての片が登録名に一致したときだけ採用する（一部だけ一致しても権限は付けない）
  const parts = value.split(LIST_DELIMITER).map((p) => p.trim()).filter(Boolean);
  const hits = parts.map((p) => known.get(key(p)));
  return parts.length > 1 && hits.every((h): h is string => h !== undefined) ? hits : null;
}

const sameSet = (a: string[], b: string[]) => {
  const sa = new Set(a);
  const sb = new Set(b);
  return sa.size === sb.size && [...sa].every((x) => sb.has(x));
};

/** 照合用のキー。全角英数→半角、大文字化（「ＩＴ部」「it」）、接尾辞（部・課など）の除去 */
function key(s: string): string {
  return s.normalize("NFKC").trim().toUpperCase().replace(SUFFIX, "");
}
