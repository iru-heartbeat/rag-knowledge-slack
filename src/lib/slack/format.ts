import type { AnswerResult, AnswerSource } from "../rag/answer";

/** Slack の1ブロックあたりの本文の上限は3000字 */
const MAX_BLOCK_CHARS = 3000;

export type SlackReply = { text: string; blocks: unknown[] };

/** 回答を Slack の表示形式（mrkdwn）に整える */
export function formatReply(result: AnswerResult): SlackReply {
  const body = truncate(toSlackMarkdown(result.answer));
  const blocks: unknown[] = [{ type: "section", text: { type: "mrkdwn", text: body } }];

  if (result.sources.length > 0) {
    const lines = result.sources.map((s) => `• ${sourceLine(s)}`);
    blocks.push({ type: "divider" });
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: truncate(`*出典*\n${lines.join("\n")}`) },
    });
  }
  // text は通知やブロックを表示できない場面で使われる
  return { text: escapeSlack(result.answer.slice(0, 300)), blocks };
}

/**
 * Claude の Markdown を Slack 用に直す。
 * 先に & < > を無害化する: <!channel> や <@U…> がそのまま届くと、全員への通知や
 * 意図しないメンションになってしまうため（文書や質問に含まれる文字がそのまま回答に出うる）。
 */
function toSlackMarkdown(s: string): string {
  return escapeSlack(s).replace(/\*\*(.+?)\*\*/g, "*$1*");
}

const escapeSlack = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function sourceLine(s: AnswerSource): string {
  // リンクの書式 <url|表示名> を壊す文字は、表示名から除く
  const name = escapeSlack(s.title.replace(/[|<>]/g, "/"));
  // Slack がリンクとして扱えるのは http(s) だけ。書式を壊す文字を含む URL もリンクにしない
  const linkable = /^https?:\/\/[^\s<>|]+$/.test(s.url);
  // Slack の書式では、URL の & も &amp; にする決まり（クエリつきの URL が壊れないように）
  const title = linkable ? `<${s.url.replace(/&/g, "&amp;")}|${name}>` : name;

  const date = s.docDate ?? (s.docYear ? `${s.docYear}年` : null);
  const meta = [s.sectionTitle, date, s.customer].filter((v): v is string => Boolean(v)).map(escapeSlack);
  return meta.length > 0 ? `${title}（${meta.join("・")}）` : title;
}

function truncate(s: string): string {
  if (s.length <= MAX_BLOCK_CHARS) return s;
  // 無害化した記号（&amp; など）の途中で切ると、&am のような欠片が残る。欠片は落とす
  return s.slice(0, MAX_BLOCK_CHARS - 1).replace(/&[a-z]*$/, "") + "…";
}
