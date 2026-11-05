import { describe, expect, it } from "vitest";
import { isAuthorizedCron } from "./cron-auth";

const SECRET = "a".repeat(64);

describe("isAuthorizedCron", () => {
  it("Authorization: Bearer <正しい合言葉> なら通る（Vercel Cron が自動で付ける形）", () => {
    expect(isAuthorizedCron(`Bearer ${SECRET}`, SECRET)).toBe(true);
  });

  it("合言葉が違えば通らない", () => {
    expect(isAuthorizedCron(`Bearer ${"b".repeat(64)}`, SECRET)).toBe(false);
  });

  it("ヘッダーが無い・Bearer 形式でない場合は通らない", () => {
    expect(isAuthorizedCron(null, SECRET)).toBe(false);
    expect(isAuthorizedCron(SECRET, SECRET)).toBe(false);
    expect(isAuthorizedCron(`Basic ${SECRET}`, SECRET)).toBe(false);
  });

  it("長さが違っても例外にせず false", () => {
    expect(isAuthorizedCron("Bearer x", SECRET)).toBe(false);
  });

  it("サーバー側の合言葉が未設定・空なら、何を送られても通さない（設定漏れで無防備にならない）", () => {
    expect(isAuthorizedCron("Bearer ", "")).toBe(false);
    expect(isAuthorizedCron("Bearer ", undefined)).toBe(false);
    expect(isAuthorizedCron("Bearer undefined", undefined)).toBe(false);
  });
});
