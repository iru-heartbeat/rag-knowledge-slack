import { after } from "next/server";
import { requireEnv } from "@/lib/config";
import { parseSlackRequest } from "@/lib/slack/events";
import { handleQuestion } from "@/lib/slack/handle";
import { createHandlerDeps } from "@/lib/slack/wire";

// 回答の生成は after() の中で続くため、その分の実行時間を確保する（Vercel の関数の最大実行時間）
export const maxDuration = 60;

/**
 * Slack の Events API の受け口。
 * Slack は 3 秒以内の応答を求めるので、署名を確かめたらすぐ 200 を返し、
 * 検索と回答生成は after()（応答を返した後も続けて動かす仕組み）で行ってスレッドに投稿する。
 */
export async function POST(req: Request): Promise<Response> {
  // 署名の計算には加工前の本文が必要。先に json() で読むと署名が合わなくなる
  const rawBody = await req.text();
  const parsed = parseSlackRequest({
    rawBody,
    headers: req.headers,
    signingSecret: requireEnv("SLACK_SIGNING_SECRET"),
  });

  switch (parsed.kind) {
    case "unauthorized":
      return new Response("invalid signature", { status: 401 });
    case "challenge":
      return Response.json({ challenge: parsed.challenge });
    case "ignore":
      return new Response(null, { status: 200 });
    case "question":
      after(async () => {
        try {
          // 部品の組み立て（環境変数の不備など）で失敗しても、原因がログに残るようにする
          await handleQuestion(parsed, createHandlerDeps());
        } catch (e) {
          console.error("Slack の質問の処理を開始できませんでした:", e);
        }
      });
      return new Response(null, { status: 200 });
  }
}
