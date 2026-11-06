import { config } from "../config";
import type { SearchFilters } from "../rag/retrieve";

export type ParsedSearch =
  | { kind: "empty" }
  | { kind: "error"; message: string }
  | { kind: "ok"; question: string; filters: SearchFilters };

const MAX_QUERY = config.limits.maxQuestionChars;
const MAX_CUSTOMER = 100;

type Raw = Record<string, string | string[] | undefined>;

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

/**
 * URL の検索条件（?q=…&dept=…）を検査して整える。URL は利用者が自由に書き換えられるので、値を信用しない。
 * 特に部署は、自分の所属部署の中からしか選べない（書き換えて他部署を指定しても、エラーにする）。
 * ※ 権限そのものは、この検査ではなく DB 関数 match_chunks が質問者のIDで必ず絞る。これは入力の健全性の確認。
 */
export function parseSearchParams(raw: Raw, allowedDepartmentIds: number[]): ParsedSearch {
  const question = first(raw.q).trim();
  if (!question) return { kind: "empty" };
  if (question.length > MAX_QUERY) return { kind: "error", message: `検索語は${MAX_QUERY}文字以内にしてください。` };

  const filters: SearchFilters = {};

  const dept = first(raw.dept).trim();
  if (dept) {
    const id = /^\d+$/.test(dept) ? Number(dept) : NaN;
    if (!allowedDepartmentIds.includes(id)) return { kind: "error", message: "指定できない部署です。" };
    filters.departmentId = id;
  }

  const customer = first(raw.customer).trim();
  if (customer.length > MAX_CUSTOMER) {
    return { kind: "error", message: `客先は${MAX_CUSTOMER}文字以内にしてください。` };
  }
  if (customer) filters.customer = customer;

  for (const [key, field, label] of [
    ["from", "dateFrom", "開始日"],
    ["to", "dateTo", "終了日"],
  ] as const) {
    const v = first(raw[key]).trim();
    if (!v) continue;
    if (!isRealDate(v)) return { kind: "error", message: `${label}は YYYY-MM-DD の形式で、実在する日付を指定してください。` };
    filters[field] = v;
  }
  if (filters.dateFrom && filters.dateTo && filters.dateFrom > filters.dateTo) {
    return { kind: "error", message: "開始日は終了日より前にしてください。" };
  }

  return { kind: "ok", question, filters };
}

function isRealDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  // 2024-02-30 のような存在しない日付は、繰り上がって別の日になる。元に戻らなければ不正
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

/** 文書へのリンクにしてよい URL か。http(s) 以外（javascript: など）はリンクにしない */
export function safeHref(url: string): string | null {
  return /^https?:\/\/[^\s]+$/i.test(url) ? url : null;
}
