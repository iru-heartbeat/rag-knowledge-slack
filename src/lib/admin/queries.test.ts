import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { findAdminUser, loadDashboard, loadQueryLogs } from "./queries";

type Row = Record<string, unknown>;

/** Supabase の偽物。どの条件で絞り込んだかを記録し、テーブルごとの返却行を指定できる */
function fakeDb(tables: Record<string, Row[]>, rpcRows: Row[] = [], error?: string) {
  const calls: Array<{ table: string; eq: Array<[string, unknown]>; order?: string; limit?: number }> = [];
  const rpc = vi.fn(async () => ({ data: rpcRows, error: error ? { message: error } : null }));
  const from = (table: string) => {
    const call = { table, eq: [] as Array<[string, unknown]>, order: undefined as string | undefined, limit: undefined as number | undefined };
    calls.push(call);
    const result = () => ({ data: tables[table] ?? [], error: error ? { message: error } : null });
    const b: Record<string, unknown> = {};
    Object.assign(b, {
      select: () => b,
      eq: (c: string, v: unknown) => (call.eq.push([c, v]), b),
      order: (c: string) => ((call.order = c), b),
      limit: (n: number) => ((call.limit = n), b),
      maybeSingle: () => Promise.resolve({ data: (tables[table] ?? [])[0] ?? null, error: error ? { message: error } : null }),
      then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(result()).then(res, rej),
    });
    return b;
  };
  return { db: { from, rpc } as unknown as SupabaseClient, calls, rpc };
}

describe("findAdminUser", () => {
  it("auth_user_id が一致し is_admin=true の users を探す（条件を両方付ける）", async () => {
    const { db, calls } = fakeDb({ users: [{ id: "u1", email: "a@example.com" }] });
    expect(await findAdminUser(db, "auth-1")).toEqual({ userId: "u1", email: "a@example.com" });
    expect(calls[0].eq).toEqual([
      ["auth_user_id", "auth-1"],
      ["is_admin", true],
    ]);
  });

  it("該当がなければ null（管理者ではない）", async () => {
    const { db } = fakeDb({ users: [] });
    expect(await findAdminUser(db, "auth-1")).toBeNull();
  });

  it("DB のエラーは握りつぶさず例外にする（誤って管理者扱いにも、無言の拒否にもしない）", async () => {
    const { db } = fakeDb({}, [], "boom");
    await expect(findAdminUser(db, "auth-1")).rejects.toThrow(/boom/);
  });
});

describe("loadDashboard", () => {
  it("最近の同期・失敗・部署未判定の文書をまとめて返す。新しい順に、件数を絞って取る", async () => {
    const { db, calls, rpc } = fakeDb(
      {
        ingestion_runs: [{ id: 3, status: "done" }],
        ingestion_errors: [{ id: 9, error_message: "壊れたPDF" }],
      },
      [{ id: "d1", title: "未判定.pdf" }],
    );
    const d = await loadDashboard(db);

    expect(d.runs).toEqual([{ id: 3, status: "done" }]);
    expect(d.errors).toEqual([{ id: 9, error_message: "壊れたPDF" }]);
    expect(d.unassigned).toEqual([{ id: "d1", title: "未判定.pdf" }]);
    expect(rpc).toHaveBeenCalledWith("unassigned_documents", { p_limit: 100 });

    const runs = calls.find((c) => c.table === "ingestion_runs")!;
    expect(runs.order).toBe("started_at");
    expect(runs.limit).toBe(10);
    const errs = calls.find((c) => c.table === "ingestion_errors")!;
    expect(errs.order).toBe("created_at");
    expect(errs.limit).toBe(50);
  });

  it("どれか1つでも取得に失敗したら例外にする", async () => {
    const { db } = fakeDb({}, [], "boom");
    await expect(loadDashboard(db)).rejects.toThrow(/boom/);
  });
});

describe("loadQueryLogs", () => {
  const row = (over: Row = {}): Row => ({
    id: 5,
    created_at: "2026-11-05T01:00:00Z",
    channel: "slack",
    question: "DXの進め方は？",
    answer: "答え [1]",
    source_chunk_ids: [11, 12],
    latency_ms: 4200,
    users: { email: "a@example.com", display_name: "山田" },
    ...over,
  });

  it("新しい順に、既定で100件まで取り、画面向けの形に整える", async () => {
    const { db, calls } = fakeDb({ query_logs: [row()] });
    expect(await loadQueryLogs(db)).toEqual([
      {
        id: 5,
        createdAt: "2026-11-05T01:00:00Z",
        channel: "slack",
        question: "DXの進め方は？",
        answer: "答え [1]",
        sourceCount: 2,
        latencyMs: 4200,
        userLabel: "山田",
      },
    ]);
    expect(calls[0]).toMatchObject({ table: "query_logs", order: "created_at", limit: 100 });
  });

  it("件数の指定は 1〜200 に収める（極端な値で重いクエリにしない）", async () => {
    const a = fakeDb({ query_logs: [] });
    await loadQueryLogs(a.db, 100000);
    expect(a.calls[0].limit).toBe(200);
    const b = fakeDb({ query_logs: [] });
    await loadQueryLogs(b.db, 0);
    expect(b.calls[0].limit).toBe(1);
  });

  it("利用者は表示名、無ければメール、削除された利用者なら「(削除済み)」と表示する", async () => {
    const { db } = fakeDb({
      query_logs: [
        row({ id: 1, users: { email: "a@example.com", display_name: null } }),
        row({ id: 2, users: null }),
      ],
    });
    const logs = await loadQueryLogs(db);
    expect(logs.map((l) => l.userLabel)).toEqual(["a@example.com", "(削除済み)"]);
  });

  it("回答が未記録（処理の途中で失敗した質問）は answer を null のまま返し、根拠は0件とする", async () => {
    const { db } = fakeDb({ query_logs: [row({ answer: null, source_chunk_ids: null, latency_ms: null })] });
    const [log] = await loadQueryLogs(db);
    expect(log).toMatchObject({ answer: null, sourceCount: 0, latencyMs: null });
  });

  it("取得に失敗したら例外にする", async () => {
    const { db } = fakeDb({}, [], "boom");
    await expect(loadQueryLogs(db)).rejects.toThrow(/boom/);
  });
});
