import { describe, expect, it } from "vitest";
import type { AnswerResult, AnswerSource } from "../rag/answer";
import { formatReply } from "./format";

const source = (over: Partial<AnswerSource> = {}): AnswerSource => ({
  title: "提案書.pdf",
  url: "https://example.com/1",
  sectionTitle: "3. アプローチ",
  docDate: null,
  docYear: 2024,
  customer: "地方銀行A",
  ...over,
});

const answered = (answer: string, sources: AnswerSource[] = [source()]): AnswerResult => ({
  status: "answered",
  answer,
  sources,
});

const allText = (r: ReturnType<typeof formatReply>) => JSON.stringify(r.blocks);

describe("formatReply", () => {
  it("Claude の **太字** を Slack の *太字* に直す", () => {
    expect(allText(formatReply(answered("**重要** な点 [1]")))).toContain("*重要* な点");
  });

  it("本文の < > & は Slack が解釈しないよう無害化する（意図しないメンションやリンクを防ぐ）", () => {
    const out = allText(formatReply(answered("<!channel> と <@U1> と a&b [1]")));
    expect(out).not.toContain("<!channel>");
    expect(out).not.toContain("<@U1>");
    expect(out).toContain("&lt;!channel&gt;");
    expect(out).toContain("a&amp;b");
  });

  it("出典は http(s) ならリンクにし、見出し・年・客先を添える", () => {
    const out = allText(formatReply(answered("答え [1]")));
    expect(out).toContain("<https://example.com/1|提案書.pdf>");
    expect(out).toContain("3. アプローチ");
    expect(out).toContain("2024年");
    expect(out).toContain("地方銀行A");
  });

  it("日付があれば年より日付を出す", () => {
    expect(allText(formatReply(answered("a", [source({ docDate: "2024-04-01" })])))).toContain("2024-04-01");
  });

  it("URL に含まれる & は &amp; にする（Slack の書式の決まり。クエリつきの URL が壊れないように）", () => {
    const out = allText(formatReply(answered("a", [source({ url: "https://example.com/a?x=1&y=2" })])));
    expect(out).toContain("<https://example.com/a?x=1&amp;y=2|提案書.pdf>");
  });

  it("上限で切るとき、&amp; のような記号の途中では切らない", () => {
    // 3000字に収まる位置で & が切れ目にかかるように並べる
    const r = formatReply(answered("あ".repeat(2995) + "&&&&&&"));
    const text = (r.blocks as Array<{ text?: { text: string } }>)[0].text!.text;
    expect(text.length).toBeLessThanOrEqual(3000);
    expect(text).not.toMatch(/&[a-z]*…$/);
  });

  it("リンクにできない URL(file:// など)は、文書名だけを出す", () => {
    const out = allText(formatReply(answered("a", [source({ url: "file:///C:/x.pdf" })])));
    expect(out).toContain("提案書.pdf");
    expect(out).not.toContain("<file:");
  });

  it("文書名の | > < がリンクの書式を壊さないようにする", () => {
    const out = allText(formatReply(answered("a", [source({ title: "A|B>C<D.pdf" })])));
    expect(out).not.toContain("|A|B");
    expect(out).toContain("A/B/C/D.pdf");
  });

  it("根拠が無い(not_found)・拒否(refused)の返信には出典ブロックを付けない", () => {
    const r = formatReply({ status: "not_found", answer: "見つかりません", sources: [] });
    expect(allText(r)).toContain("見つかりません");
    expect(allText(r)).not.toContain("出典");
  });

  it("長すぎる本文は Slack の上限(3000字)内に切り詰める", () => {
    const r = formatReply(answered("あ".repeat(5000)));
    const section = (r.blocks as Array<{ text?: { text: string } }>)[0];
    expect(section.text!.text.length).toBeLessThanOrEqual(3000);
  });

  it("通知用の text も同じ無害化をする（<!channel> が通知側で解釈されないように）", () => {
    const r = formatReply(answered("<!channel> 見て <@U1> a&b"));
    expect(r.text).not.toContain("<!channel>");
    expect(r.text).not.toContain("<@U1>");
    expect(r.text).toContain("&lt;!channel&gt;");
    expect(r.text).toContain("a&amp;b");
  });

  it("通知用の text も付ける（ブロックを表示できない場面で使われる）", () => {
    expect(formatReply(answered("答えです [1]")).text).toContain("答えです");
  });
});
