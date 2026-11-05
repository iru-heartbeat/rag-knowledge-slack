import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { listUserDepartments, resolveWebUser } from "./user";

type User = { id: string; email: string | null; auth_user_id: string | null };

/** users テーブルの偽物（eq / is の絞り込みと update の紐づけだけ再現）。user_departments は別に返す */
function fakeDb(users: User[], opts: { updateError?: boolean; userDepartments?: Array<Record<string, unknown>> } = {}) {
  const updates: Array<{ id: string; auth_user_id: string }> = [];
  const from = (table: string) => {
    const filters: Array<(u: User) => boolean> = [];
    let patch: Partial<User> | undefined;
    const b: Record<string, unknown> = {};
    const run = () => {
      if (table === "user_departments") return { data: opts.userDepartments ?? [], error: null };
      const rows = users.filter((u) => filters.every((f) => f(u)));
      if (patch) {
        if (opts.updateError) return { data: null, error: { message: "unique violation" } };
        for (const u of rows) {
          Object.assign(u, patch);
          updates.push({ id: u.id, auth_user_id: patch.auth_user_id as string });
        }
      }
      return { data: rows, error: null };
    };
    Object.assign(b, {
      select: () => b,
      update: (p: Partial<User>) => ((patch = p), b),
      eq: (col: keyof User, v: unknown) => (filters.push((u) => u[col] === v), b),
      is: (col: keyof User, v: unknown) => (filters.push((u) => u[col] === v), b),
      maybeSingle: () => {
        const r = run();
        return Promise.resolve({ data: (r.data as unknown[] | null)?.[0] ?? null, error: r.error });
      },
      then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(run()).then(res, rej),
    });
    return b;
  };
  return { db: { from } as unknown as SupabaseClient, updates };
}

const bob: User = { id: "u-bob", email: "bob@example.com", auth_user_id: null };
const auth = (over: Partial<{ id: string; email: string | null; emailConfirmed: boolean }> = {}) => ({
  id: "auth-1",
  email: "bob@example.com",
  emailConfirmed: true,
  ...over,
});

describe("resolveWebUser", () => {
  it("紐づけ済みなら、そのまま users を返す", async () => {
    const { db } = fakeDb([{ ...bob, auth_user_id: "auth-1" }]);
    expect(await resolveWebUser(db, auth())).toEqual({ userId: "u-bob", email: "bob@example.com" });
  });

  it("未紐づけなら、確認済みのメールで users を探して初回だけ紐づける", async () => {
    const { db, updates } = fakeDb([{ ...bob }]);
    expect(await resolveWebUser(db, auth({ email: "Bob@Example.COM" }))).toEqual({
      userId: "u-bob",
      email: "bob@example.com",
    });
    expect(updates).toEqual([{ id: "u-bob", auth_user_id: "auth-1" }]);
  });

  it("メールが未確認のアカウントは、メールの一致だけでは紐づけない（他人のメールを名乗れてしまうため）", async () => {
    const { db, updates } = fakeDb([{ ...bob }]);
    expect(await resolveWebUser(db, auth({ emailConfirmed: false }))).toBeNull();
    expect(updates).toEqual([]);
  });

  it("users に登録のないメールは null", async () => {
    const { db } = fakeDb([{ ...bob }]);
    expect(await resolveWebUser(db, auth({ email: "stranger@example.com" }))).toBeNull();
  });

  it("すでに別のログインアカウントに紐づいている users は、乗っ取りを防ぐため null", async () => {
    const { db, updates } = fakeDb([{ ...bob, auth_user_id: "auth-other" }]);
    expect(await resolveWebUser(db, auth())).toBeNull();
    expect(updates).toEqual([]);
  });

  it("メールが無いアカウントは null", async () => {
    const { db } = fakeDb([{ ...bob }]);
    expect(await resolveWebUser(db, auth({ email: null }))).toBeNull();
  });

  it("紐づけの保存に失敗したら null（権限を付けすぎない側に倒す）", async () => {
    const { db } = fakeDb([{ ...bob }], { updateError: true });
    expect(await resolveWebUser(db, auth())).toBeNull();
  });
});

describe("listUserDepartments", () => {
  it("ユーザーの所属部署を、部署名つきで返す", async () => {
    const { db } = fakeDb([], {
      userDepartments: [
        { departments: { id: 5, name: "営業" } },
        { departments: { id: 1, name: "戦略" } },
      ],
    });
    expect(await listUserDepartments(db, "u-bob")).toEqual([
      { id: 1, name: "戦略" },
      { id: 5, name: "営業" },
    ]);
  });
});
