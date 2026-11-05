import type { Section } from "./chunk";

const SCAN_CHARS = 2000;

// 同じ文書に対して部署抽出・メタデータ抽出が続けて呼ぶので、結果を使い回す（配列が破棄されれば自動で消える）
const cache = new WeakMap<Section[], string>();

/**
 * 文書の冒頭テキスト。部署・客先・日付など「表紙の記載」を探す範囲。
 * NFKC で全角英数・記号を半角に統一する（「２０２４年」「：」などの表記ゆれ対策）。
 *
 * 文書全体を結合・正規化してから切ると、巨大な文書で無駄が大きい。
 * 先頭から必要な分だけ集めて、足りたらそこで打ち切る。
 */
export function documentHead(sections: Section[], maxChars = SCAN_CHARS): string {
  const useCache = maxChars === SCAN_CHARS;
  if (useCache) {
    const cached = cache.get(sections);
    if (cached !== undefined) return cached;
  }

  const parts: string[] = [];
  let length = 0;
  for (const s of sections) {
    if (length >= maxChars) break;
    // 見出しは「親 > 子 > 孫」の全体ではなく末尾だけ付ける（親の繰り返しで枠を使い切らないため）
    const title = s.title?.split(" > ").pop();
    const remaining = maxChars - length;
    // 正規化の前に切って、巨大なセクションでも冒頭だけを処理する。
    // NFKC は文字数を変えることがあるので（「か」+濁点→「が」で縮む）、余裕を持たせて切る
    const raw = (title ? `${title}\n${s.text.slice(0, remaining * 2)}` : s.text.slice(0, remaining * 2)).normalize("NFKC");
    parts.push(raw);
    length += raw.length + 1; // +1 は結合時の改行
  }

  const head = parts.join("\n").slice(0, maxChars);
  if (useCache) cache.set(sections, head);
  return head;
}
