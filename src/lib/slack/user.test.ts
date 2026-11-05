import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { resolveUserId } from "./user";

type User = { id: string; email: string | null; slack_user_id: string | null };

/** users テーブルの偽物。eq / is の絞り込みと、update（slack_user_id の紐づけ）だけを再現する */
function fakeDb(users: User[], opts: { updateError?: boolean } = {}) {
  const updates: Array<{ id: string; slack_user_id: string }> = [];
  const from = (table: string) => {
    if (table !== "users") throw new Error(`想定外のテーブル: ${table}`);
    const filters: Array<(u: User) => boolean> = [];
    let patch: Partial<User> | undefined;
    const b: Record<string, unknown> = {};
    const rows = () => users.filter((u) => filters.every((f) => f(u)));
    const run = () => {
      if (patch) {
        if (opts.updateError) return { data: null, error: { message: "unique violation" } };
        const hit = rows();
        for (const u of hit) {
          Object.assign(u, patch);
          updates.push({ id: u.id, slack_user_id: patch.slack_user_id as string });
        }
        return { data: hit.map((u) => ({ id: u.id })), error: null };
      }
      return { data: rows(), error: null };
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
    });
    return b;
  };
  return { db: { from } as unknown as SupabaseClient, updates };
}

const alice: User = { id: "u-alice", email: "alice@example.com", slack_user_id: null };

describe("resolveUserId", () => {
  it("紐づけ済みの Slack ユーザーは、Slack API を呼ばずに users.id を返す", async () => {
    const { db } = fakeDb([{ ...alice, slack_user_id: "U1" }]);
    const lookupEmail = vi.fn();
    expect(await resolveUserId(db, "U1", lookupEmail)).toBe("u-alice");
    expect(lookupEmail).not.toHaveBeenCalled();
  });

  it("未紐づけなら Slack のメールアドレスで users を探し、見つかれば紐づけて返す", async () => {
    const { db, updates } = fakeDb([{ ...alice }]);
    expect(await resolveUserId(db, "U1", async () => "alice@example.com")).toBe("u-alice");
    expect(updates).toEqual([{ id: "u-alice", slack_user_id: "U1" }]);
  });

  it("メールの大文字小文字の違いは同じとみなす", async () => {
    const { db } = fakeDb([{ ...alice }]);
    expect(await resolveUserId(db, "U1", async () => "Alice@Example.COM")).toBe("u-alice");
  });

  it("users に登録のないメールは null（検索させない）", async () => {
    const { db, updates } = fakeDb([{ ...alice }]);
    expect(await resolveUserId(db, "U9", async () => "stranger@example.com")).toBeNull();
    expect(updates).toEqual([]);
  });

  it("Slack からメールが取れない場合は null", async () => {
    const { db } = fakeDb([{ ...alice }]);
    expect(await resolveUserId(db, "U1", async () => null)).toBeNull();
  });

  it("そのユーザーがすでに別の Slack アカウントに紐づいている場合は、乗っ取りを防ぐため null", async () => {
    const { db, updates } = fakeDb([{ ...alice, slack_user_id: "U-other" }]);
    expect(await resolveUserId(db, "U-new", async () => "alice@example.com")).toBeNull();
    expect(updates).toEqual([]);
  });

  it("紐づけの保存に失敗したら null（権限を付けすぎない側に倒す）", async () => {
    const { db } = fakeDb([{ ...alice }], { updateError: true });
    expect(await resolveUserId(db, "U1", async () => "alice@example.com")).toBeNull();
  });
});
