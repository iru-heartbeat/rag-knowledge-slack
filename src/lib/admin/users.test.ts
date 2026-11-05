import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import {
  deleteUser,
  listUsers,
  saveUser,
  unlinkSlack,
  UserInputError,
  validateUserInput,
} from "./users";

type Row = Record<string, unknown>;

describe("validateUserInput", () => {
  const form = (o: Record<string, string | string[]>) => {
    const f = new FormData();
    for (const [k, v] of Object.entries(o)) for (const x of Array.isArray(v) ? v : [v]) f.append(k, x);
    return f;
  };

  it("メールは前後の空白を除き、小文字にそろえる（Slack との照合が小文字で行われるため）", () => {
    const r = validateUserInput(form({ email: "  Alice@Example.COM ", displayName: "  山田 太郎 " }));
    expect(r).toEqual({ email: "alice@example.com", displayName: "山田 太郎", departmentIds: [] });
  });

  it("メールが空・形式が不正・長すぎる場合はエラー", () => {
    expect(() => validateUserInput(form({ email: "" }))).toThrow(UserInputError);
    expect(() => validateUserInput(form({ email: "not-an-email" }))).toThrow(/メール/);
    expect(() => validateUserInput(form({ email: "a b@example.com" }))).toThrow(/メール/);
    expect(() => validateUserInput(form({ email: "a".repeat(250) + "@example.com" }))).toThrow(/メール/);
  });

  it("表示名は空なら null、長すぎればエラー", () => {
    expect(validateUserInput(form({ email: "a@b.co", displayName: "  " })).displayName).toBeNull();
    expect(() => validateUserInput(form({ email: "a@b.co", displayName: "あ".repeat(101) }))).toThrow(/名前/);
  });

  it("部署は整数だけを重複なしで受け取り、数字でない値はエラー", () => {
    expect(validateUserInput(form({ email: "a@b.co", departmentIds: ["2", "5", "2"] })).departmentIds).toEqual([2, 5]);
    expect(() => validateUserInput(form({ email: "a@b.co", departmentIds: ["1; drop"] }))).toThrow(/部署/);
    expect(() => validateUserInput(form({ email: "a@b.co", departmentIds: ["1.5"] }))).toThrow(/部署/);
  });
});

/** Supabase の偽物。テーブルごとの返却行・rpc の結果・delete/update の対象を記録する */
function fakeDb(opts: { tables?: Record<string, Row[]>; rpc?: { data?: unknown; error?: { code?: string; message: string } } } = {}) {
  const rpc = vi.fn(async () => ({ data: opts.rpc?.data ?? "user-id", error: opts.rpc?.error ?? null }));
  const ops: Array<{ table: string; op: string; eq: Array<[string, unknown]>; patch?: Row }> = [];
  const from = (table: string) => {
    const rows = opts.tables?.[table] ?? [];
    const rec = { table, op: "select", eq: [] as Array<[string, unknown]>, patch: undefined as Row | undefined };
    ops.push(rec);
    const b: Record<string, unknown> = {};
    Object.assign(b, {
      select: () => b,
      order: () => b,
      update: (p: Row) => ((rec.op = "update"), (rec.patch = p), b),
      delete: () => ((rec.op = "delete"), b),
      eq: (c: string, v: unknown) => (rec.eq.push([c, v]), b),
      then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
        Promise.resolve({ data: rows, error: null }).then(res, rej),
    });
    return b;
  };
  return { db: { from, rpc } as unknown as SupabaseClient, rpc, ops };
}

describe("listUsers", () => {
  it("ユーザーに所属部署の名前を付けて返し、部署の一覧も返す", async () => {
    const { db } = fakeDb({
      tables: {
        departments: [
          { id: 1, name: "戦略" },
          { id: 5, name: "営業" },
        ],
        users: [
          {
            id: "u1",
            email: "a@example.com",
            display_name: "山田",
            slack_user_id: "U1",
            is_admin: false,
            user_departments: [{ department_id: 5 }, { department_id: 1 }],
          },
        ],
      },
    });
    const r = await listUsers(db);
    expect(r.departments).toEqual([
      { id: 1, name: "戦略" },
      { id: 5, name: "営業" },
    ]);
    expect(r.users[0]).toMatchObject({ id: "u1", email: "a@example.com", slackLinked: true, isAdmin: false });
    expect(r.users[0].departmentIds.sort()).toEqual([1, 5]);
  });
});

describe("saveUser", () => {
  const input = { email: "a@example.com", displayName: "山田", departmentIds: [1, 5] };

  it("新規は p_id=null で、更新は id を付けて save_user を呼ぶ", async () => {
    const a = fakeDb();
    expect(await saveUser(a.db, null, input)).toBe("user-id");
    expect(a.rpc).toHaveBeenCalledWith("save_user", {
      p_id: null,
      p_email: "a@example.com",
      p_display_name: "山田",
      p_department_ids: [1, 5],
    });
    const b = fakeDb();
    await saveUser(b.db, "u9", input);
    expect((b.rpc.mock.calls[0] as unknown[])[1]).toMatchObject({ p_id: "u9" });
  });

  it("メールの重複(23505)は、利用者に伝わる入力エラーにする", async () => {
    const { db } = fakeDb({ rpc: { error: { code: "23505", message: "duplicate key" } } });
    await expect(saveUser(db, null, input)).rejects.toThrow(/すでに登録/);
    await expect(saveUser(db, null, input)).rejects.toBeInstanceOf(UserInputError);
  });

  it("存在しない部署(23503)・存在しないユーザー(P0002)も入力エラーにする", async () => {
    const a = fakeDb({ rpc: { error: { code: "23503", message: "fk" } } });
    await expect(saveUser(a.db, null, input)).rejects.toThrow(/部署/);
    const b = fakeDb({ rpc: { error: { code: "P0002", message: "user not found" } } });
    await expect(saveUser(b.db, "x", input)).rejects.toThrow(/見つかりません/);
  });

  it("想定外のエラーは内部の詳細ごと通常の例外にする（利用者向けの入力エラーにしない）", async () => {
    const { db } = fakeDb({ rpc: { error: { code: "XX000", message: "internal" } } });
    const p = saveUser(db, null, input);
    await expect(p).rejects.toThrow(/internal/);
    await expect(p).rejects.not.toBeInstanceOf(UserInputError);
  });
});

describe("deleteUser", () => {
  it("管理者(is_admin)は消せない条件を付けて削除する", async () => {
    const { db, ops } = fakeDb({ tables: { users: [{ id: "u1" }] } });
    await deleteUser(db, "u1");
    const del = ops.find((o) => o.op === "delete")!;
    expect(del.eq).toEqual([
      ["id", "u1"],
      ["is_admin", false],
    ]);
  });

  it("対象が無かった（管理者・存在しない）場合は入力エラー", async () => {
    const { db } = fakeDb({ tables: { users: [] } });
    await expect(deleteUser(db, "u1")).rejects.toThrow(UserInputError);
  });
});

describe("unlinkSlack", () => {
  it("slack_user_id を空にする", async () => {
    const { db, ops } = fakeDb({ tables: { users: [{ id: "u1" }] } });
    await unlinkSlack(db, "u1");
    const up = ops.find((o) => o.op === "update")!;
    expect(up.patch).toEqual({ slack_user_id: null });
    expect(up.eq).toEqual([["id", "u1"]]);
  });
});
