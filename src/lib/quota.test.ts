import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { config } from "./config";
import { completeQuery, reserveQuery } from "./quota";

type Row = Record<string, unknown>;

/** query_logs の偽物。insert / 件数の取得 / delete / update を、記録しながら再現する */
function fakeDb(opts: { existingInWindow?: number; countError?: boolean; insertError?: boolean } = {}) {
  const log = { inserted: [] as Row[], deleted: [] as unknown[], updated: [] as Array<{ patch: Row; id: unknown }>, gte: [] as unknown[], eq: [] as Array<[string, unknown]> };
  const from = (table: string) => {
    if (table !== "query_logs") throw new Error(`想定外のテーブル: ${table}`);
    let op: "select" | "insert" | "delete" | "update" = "select";
    let patch: Row = {};
    let eqId: unknown;
    const b: Record<string, unknown> = {};
    const run = () => {
      if (op === "insert") {
        if (opts.insertError) return { data: null, error: { message: "insert failed" } };
        log.inserted.push(patch);
        return { data: { id: 100 }, error: null };
      }
      if (op === "delete") log.deleted.push(eqId);
      if (op === "update") log.updated.push({ patch, id: eqId });
      if (op === "select") {
        if (opts.countError) return { count: null, error: { message: "count failed" } };
        // 窓の中の件数 = 既存分 + 今入れた予約行
        return { count: (opts.existingInWindow ?? 0) + log.inserted.length, error: null };
      }
      return { data: null, error: null };
    };
    Object.assign(b, {
      select: () => b,
      insert: (p: Row) => ((op = "insert"), (patch = p), b),
      delete: () => ((op = "delete"), b),
      update: (p: Row) => ((op = "update"), (patch = p), b),
      eq: (c: string, v: unknown) => (log.eq.push([c, v]), c === "id" && (eqId = v), b),
      gte: (_c: string, v: unknown) => (log.gte.push(v), b),
      single: () => Promise.resolve(run()),
      then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(run()).then(res, rej),
    });
    return b;
  };
  return { db: { from } as unknown as SupabaseClient, log };
}

const NOW = Date.parse("2026-11-04T12:00:00Z");
const args = { userId: "u1", channel: "slack" as const, question: "DXは？", nowMs: NOW };

describe("reserveQuery", () => {
  it("処理を始める前に質問の記録を作り（失敗した質問も数えるため）、その id を返す", async () => {
    const { db, log } = fakeDb();
    expect(await reserveQuery(db, args)).toBe(100);
    expect(log.inserted).toEqual([{ user_id: "u1", channel: "slack", question: "DXは？" }]);
    expect(log.eq).toContainEqual(["user_id", "u1"]);
    expect(log.gte).toEqual(["2026-11-04T11:00:00.000Z"]); // 直近1時間
  });

  it("今回の分を含めて上限ちょうどまでは通す", async () => {
    const { db } = fakeDb({ existingInWindow: config.limits.questionsPerHour - 1 });
    expect(await reserveQuery(db, args)).toBe(100);
  });

  it("上限を超えたら null を返し、作った記録は消す（断った分は費用がかからないので数えない）", async () => {
    const { db, log } = fakeDb({ existingInWindow: config.limits.questionsPerHour });
    expect(await reserveQuery(db, args)).toBeNull();
    expect(log.deleted).toEqual([100]);
  });

  it("記録の作成に失敗したら、通さずに例外にする", async () => {
    const { db } = fakeDb({ insertError: true });
    await expect(reserveQuery(db, args)).rejects.toThrow(/insert failed/);
  });

  it("件数を数えられなかったら、作った記録を消して例外にする", async () => {
    const { db, log } = fakeDb({ countError: true });
    await expect(reserveQuery(db, args)).rejects.toThrow(/count failed/);
    expect(log.deleted).toEqual([100]);
  });
});

describe("completeQuery", () => {
  it("回答・根拠チャンク・所要時間を、予約した記録に書き足す", async () => {
    const { db, log } = fakeDb();
    await completeQuery(db, 100, { answer: "答え", sourceChunkIds: [1, 2], latencyMs: 1234 });
    expect(log.updated).toEqual([
      { patch: { answer: "答え", source_chunk_ids: [1, 2], latency_ms: 1234 }, id: 100 },
    ]);
  });
});
