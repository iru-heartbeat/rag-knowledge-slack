import { verifySlackSignature } from "./verify";

/** Slack から届いたリクエストを、処理の種類に振り分けた結果 */
export type SlackRequest =
  | { kind: "unauthorized" }
  | { kind: "challenge"; challenge: string }
  | { kind: "ignore" }
  | { kind: "question"; slackUserId: string; channel: string; threadTs: string; text: string; isDirect: boolean };

type SlackEvent = {
  type?: string;
  subtype?: string;
  bot_id?: string;
  user?: string;
  text?: string;
  channel?: string;
  channel_type?: string;
  ts?: string;
  thread_ts?: string;
};

/**
 * 署名を確かめたうえで、リクエストの種類を判定する（副作用なし。実際の返信は呼び出し側が行う）。
 * 質問として扱うのは、メンション(app_mention)と、ボットへのダイレクトメッセージだけ。
 */
export function parseSlackRequest(input: {
  rawBody: string;
  headers: Headers;
  signingSecret: string;
  nowSeconds?: number;
}): SlackRequest {
  const ok = verifySlackSignature({
    signingSecret: input.signingSecret,
    timestamp: input.headers.get("x-slack-request-timestamp"),
    signature: input.headers.get("x-slack-signature"),
    rawBody: input.rawBody,
    nowSeconds: input.nowSeconds,
  });
  if (!ok) return { kind: "unauthorized" };

  let body: { type?: string; challenge?: string; event?: SlackEvent };
  try {
    body = JSON.parse(input.rawBody);
  } catch {
    return { kind: "ignore" };
  }

  // Slack の URL 登録時の接続確認
  if (body.type === "url_verification" && typeof body.challenge === "string") {
    return { kind: "challenge", challenge: body.challenge };
  }

  // 3秒以内に応答できないと Slack は同じイベントを再送する。こちらは先に ack して非同期で答えるので、
  // 再送は必ず二重回答になる。無視する
  if (input.headers.get("x-slack-retry-num")) return { kind: "ignore" };

  const e = body.event;
  if (body.type !== "event_callback" || !e) return { kind: "ignore" };

  // ボットの投稿への反応や、編集・削除などの付随イベントは質問ではない（ボット同士の無限ループも防ぐ）
  if (e.bot_id || e.subtype) return { kind: "ignore" };

  const isMention = e.type === "app_mention";
  const isDirectMessage = e.type === "message" && e.channel_type === "im";
  if (!isMention && !isDirectMessage) return { kind: "ignore" };

  if (!e.user || !e.text || !e.channel || !e.ts) return { kind: "ignore" };

  return {
    kind: "question",
    slackUserId: e.user,
    channel: e.channel,
    threadTs: e.thread_ts ?? e.ts,
    text: e.text,
    isDirect: isDirectMessage,
  };
}
