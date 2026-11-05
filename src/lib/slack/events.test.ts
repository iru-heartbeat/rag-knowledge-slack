import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseSlackRequest } from "./events";

const SECRET = "s";
const NOW = 1_700_000_000;

function request(payload: unknown, opts: { headers?: Record<string, string>; secret?: string; raw?: string } = {}) {
  const rawBody = opts.raw ?? JSON.stringify(payload);
  const signature =
    "v0=" + createHmac("sha256", opts.secret ?? SECRET).update(`v0:${NOW}:${rawBody}`).digest("hex");
  const headers = new Headers({
    "x-slack-request-timestamp": String(NOW),
    "x-slack-signature": signature,
    ...opts.headers,
  });
  return parseSlackRequest({ rawBody, headers, signingSecret: SECRET, nowSeconds: NOW });
}

const callback = (event: Record<string, unknown>) => ({ type: "event_callback", event_id: "Ev1", event });

describe("parseSlackRequest", () => {
  it("署名が不正なら unauthorized（中身は読まない）", () => {
    expect(request({ type: "url_verification", challenge: "c" }, { secret: "wrong" })).toEqual({
      kind: "unauthorized",
    });
  });

  it("Slack の接続確認(url_verification)には challenge をそのまま返す", () => {
    expect(request({ type: "url_verification", challenge: "abc123" })).toEqual({
      kind: "challenge",
      challenge: "abc123",
    });
  });

  it("再送(x-slack-retry-num)は無視する。3秒以内に返せなかった時の再送で二重回答しないため", () => {
    const r = request(
      callback({ type: "app_mention", user: "U1", text: "<@UB> q", channel: "C1", ts: "1.1" }),
      { headers: { "x-slack-retry-num": "1" } },
    );
    expect(r).toEqual({ kind: "ignore" });
  });

  it("メンションは質問として受け取り、その投稿のスレッドに返信する", () => {
    expect(request(callback({ type: "app_mention", user: "U1", text: "<@UB> DXは？", channel: "C1", ts: "1.1" }))).toEqual({
      kind: "question",
      slackUserId: "U1",
      channel: "C1",
      threadTs: "1.1",
      text: "<@UB> DXは？",
      isDirect: false,
    });
  });

  it("すでにスレッド内のメンションなら、そのスレッドに返信する", () => {
    const r = request(
      callback({ type: "app_mention", user: "U1", text: "q", channel: "C1", ts: "2.2", thread_ts: "1.1" }),
    );
    expect(r).toMatchObject({ kind: "question", threadTs: "1.1" });
  });

  it("ダイレクトメッセージ(DM)も質問として受け取る", () => {
    const r = request(callback({ type: "message", channel_type: "im", user: "U1", text: "q", channel: "D1", ts: "3.3" }));
    expect(r).toMatchObject({ kind: "question", channel: "D1", threadTs: "3.3", isDirect: true });
  });

  it("ボット自身・他のボットの投稿は無視する（ボット同士の無限ループを防ぐ）", () => {
    expect(request(callback({ type: "message", channel_type: "im", bot_id: "B1", text: "q", channel: "D1", ts: "1" }))).toEqual({
      kind: "ignore",
    });
    expect(request(callback({ type: "app_mention", bot_id: "B1", user: "U1", text: "q", channel: "C1", ts: "1" }))).toEqual({
      kind: "ignore",
    });
  });

  it("編集・削除などの message_changed 等（subtype あり）は無視する", () => {
    expect(
      request(callback({ type: "message", subtype: "message_changed", channel_type: "im", user: "U1", channel: "D1", ts: "1" })),
    ).toEqual({ kind: "ignore" });
  });

  it("チャンネル内の普通の発言(メンションなし)は無視する", () => {
    expect(
      request(callback({ type: "message", channel_type: "channel", user: "U1", text: "q", channel: "C1", ts: "1" })),
    ).toEqual({ kind: "ignore" });
  });

  it("ユーザーIDやテキストが無いイベントは無視する", () => {
    expect(request(callback({ type: "app_mention", channel: "C1", ts: "1" }))).toEqual({ kind: "ignore" });
  });

  it("署名は正しいが JSON でない本文は無視する（例外にしない）", () => {
    expect(request(null, { raw: "not json" })).toEqual({ kind: "ignore" });
  });
});
