import { describe, expect, it, vi } from "vitest";
import type { AnswerResult } from "../rag/answer";
import type { RetrievedChunk } from "../rag/retrieve";
import { handleQuestion, stripMentions, type HandlerDeps } from "./handle";

const chunk = (id: number): RetrievedChunk => ({
  chunkId: id,
  documentId: `d${id}`,
  title: "t.pdf",
  url: "https://e/1",
  sectionTitle: null,
  docDate: null,
  docYear: 2024,
  customer: null,
  content: "c",
  similarity: 0.7,
});

const result: AnswerResult = { status: "answered", answer: "答え [1]", sources: [] };
const msg = { slackUserId: "U1", channel: "C1", threadTs: "1.1", text: "<@UBOT> DXの進め方は？", isDirect: false };

function deps(over: Partial<HandlerDeps> = {}) {
  const post = vi.fn(async () => {});
  const complete = vi.fn(async () => {});
  const begin = vi.fn(async () => 7 as number | null);
  const retrieve = vi.fn(async () => [chunk(11), chunk(12)]);
  const generate = vi.fn(async () => result);
  const resolveUser = vi.fn(async () => "user-1" as string | null);
  const d: HandlerDeps = { resolveUser, begin, complete, retrieve, generate, post, ...over };
  return { d, post, complete, begin, retrieve, generate, resolveUser };
}

const posted = (post: ReturnType<typeof vi.fn>) => (post.mock.calls[0] as unknown[])[0] as {
  channel: string;
  threadTs: string;
  text: string;
  blocks?: unknown[];
  ephemeralUserId?: string;
};

describe("stripMentions", () => {
  it("メンション部分を取り除いて質問だけにする", () => {
    expect(stripMentions("<@UBOT> DXの進め方は？")).toBe("DXの進め方は？");
    expect(stripMentions("<@UBOT>   <@U2>  質問  ")).toBe("質問");
    expect(stripMentions("質問だけ")).toBe("質問だけ");
    expect(stripMentions("<@UBOT>")).toBe("");
  });
});

describe("handleQuestion", () => {
  it("未登録のユーザーには検索せず、登録の案内をスレッドに返す", async () => {
    const { d, post, retrieve, begin } = deps({ resolveUser: vi.fn(async () => null) });
    await handleQuestion(msg, d);
    expect(retrieve).not.toHaveBeenCalled();
    expect(begin).not.toHaveBeenCalled();
    expect(posted(post)).toMatchObject({ channel: "C1", threadTs: "1.1" });
    expect(posted(post).text).toContain("管理者");
  });

  it("短時間に質問しすぎた人(begin が null)には、検索も回答生成もせず、しばらく待つよう返す", async () => {
    const { d, post, retrieve, generate } = deps({ begin: vi.fn(async () => null) });
    await handleQuestion(msg, d);
    expect(retrieve).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
    expect(posted(post).text).toContain("しばらく");
  });

  it("メンションだけで質問が空なら、記録も検索もせず使い方を返す", async () => {
    const { d, post, retrieve, begin } = deps();
    await handleQuestion({ ...msg, text: "<@UBOT>" }, d);
    expect(retrieve).not.toHaveBeenCalled();
    expect(begin).not.toHaveBeenCalled();
    expect(posted(post).text).toContain("質問");
  });

  it("質問者のIDと、メンションを除いた質問で検索し、回答をスレッドに返す", async () => {
    const { d, post, retrieve, generate, begin } = deps();
    await handleQuestion(msg, d);
    expect(begin).toHaveBeenCalledWith("user-1", "DXの進め方は？");
    expect(retrieve).toHaveBeenCalledWith("user-1", "DXの進め方は？");
    expect(generate).toHaveBeenCalledWith("DXの進め方は？", [chunk(11), chunk(12)]);
    expect(posted(post)).toMatchObject({ channel: "C1", threadTs: "1.1" });
    expect(posted(post).text).toContain("答え");
  });

  it("処理の前に質問を記録し（失敗しても数える）、終わったら回答・根拠チャンク・所要時間を書き足す", async () => {
    const { d, begin, complete, retrieve } = deps();
    await handleQuestion(msg, d);
    expect(begin.mock.invocationCallOrder[0]).toBeLessThan(retrieve.mock.invocationCallOrder[0]);
    expect(complete).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ answer: "答え [1]", sourceChunkIds: [11, 12], latencyMs: expect.any(Number) }),
    );
  });

  it("途中で失敗しても例外にせず、内部の詳細を含まない定型文を返す。質問の記録は残る（数えられる）", async () => {
    const { d, post, begin, complete } = deps({
      generate: vi.fn(async () => {
        throw new Error("秘密のAPIキー sk-xxx が不正です");
      }),
    });
    await expect(handleQuestion(msg, d)).resolves.toBeUndefined();
    expect(begin).toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    expect(posted(post).text).toContain("エラー");
    expect(posted(post).text).not.toContain("sk-xxx");
  });

  describe("公開チャンネルでは質問者にだけ見える形で返す（他の部署の人に回答が漏れないように）", () => {
    it("回答は質問者宛ての一時表示(ephemeral)で投稿する", async () => {
      const { d, post } = deps();
      await handleQuestion(msg, d);
      expect(posted(post)).toMatchObject({ ephemeralUserId: "U1" });
    });

    it("未登録・上限超過・空の質問・エラーの案内も同様に質問者にだけ見せる", async () => {
      for (const over of [
        { resolveUser: vi.fn(async () => null) },
        { begin: vi.fn(async () => null) },
        { generate: vi.fn(async () => { throw new Error("x"); }) },
      ]) {
        const { d, post } = deps(over);
        await handleQuestion(msg, d);
        expect(posted(post)).toMatchObject({ ephemeralUserId: "U1" });
      }
      const { d, post } = deps();
      await handleQuestion({ ...msg, text: "<@UBOT>" }, d);
      expect(posted(post)).toMatchObject({ ephemeralUserId: "U1" });
    });

    it("DMは本人しか見ないので、通常の投稿のまま", async () => {
      const { d, post } = deps();
      await handleQuestion({ ...msg, channel: "D1", isDirect: true }, d);
      expect(posted(post).ephemeralUserId).toBeUndefined();
    });
  });

  it("記録の書き足しに失敗しても、回答は返す", async () => {
    const { d, post } = deps({
      complete: vi.fn(async () => {
        throw new Error("db down");
      }),
    });
    await handleQuestion(msg, d);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("返信の投稿自体が失敗しても、例外を外に出さない（バックグラウンド処理を落とさない）", async () => {
    const { d } = deps({
      post: vi.fn(async () => {
        throw new Error("slack down");
      }),
    });
    await expect(handleQuestion(msg, d)).resolves.toBeUndefined();
  });
});
