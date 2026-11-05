import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifySlackSignature } from "./verify";

const SECRET = "test-signing-secret";
const NOW = 1_700_000_000; // 秒

const sign = (body: string, ts: number, secret = SECRET) =>
  "v0=" + createHmac("sha256", secret).update(`v0:${ts}:${body}`).digest("hex");

const verify = (over: Partial<Parameters<typeof verifySlackSignature>[0]> = {}) =>
  verifySlackSignature({
    signingSecret: SECRET,
    timestamp: String(NOW),
    signature: sign("{}", NOW),
    rawBody: "{}",
    nowSeconds: NOW,
    ...over,
  });

describe("verifySlackSignature", () => {
  it("正しい署名は通る", () => {
    expect(verify()).toBe(true);
  });

  it("別の秘密鍵で作った署名は通らない", () => {
    expect(verify({ signature: sign("{}", NOW, "other-secret") })).toBe(false);
  });

  it("本文が1文字でも書き換えられていたら通らない", () => {
    expect(verify({ rawBody: '{"a":1}' })).toBe(false);
  });

  it("5分より古いリクエストは通らない（録っておいた通信の使い回しを防ぐ）", () => {
    const old = NOW - 301;
    expect(verify({ timestamp: String(old), signature: sign("{}", old) })).toBe(false);
  });

  it("未来すぎる時刻も通らない", () => {
    const future = NOW + 301;
    expect(verify({ timestamp: String(future), signature: sign("{}", future) })).toBe(false);
  });

  it("5分以内なら通る", () => {
    const ts = NOW - 299;
    expect(verify({ timestamp: String(ts), signature: sign("{}", ts) })).toBe(true);
  });

  it("ヘッダーが無い・数字でない・長さが違う署名は、例外にせず false", () => {
    expect(verify({ timestamp: null })).toBe(false);
    expect(verify({ signature: null })).toBe(false);
    expect(verify({ timestamp: "abc" })).toBe(false);
    expect(verify({ signature: "v0=abc" })).toBe(false);
    expect(verify({ signature: "" })).toBe(false);
  });

  it("署名の鍵が空なら、必ず通らない", () => {
    expect(verify({ signingSecret: "", signature: sign("{}", NOW, "") })).toBe(false);
  });
});
