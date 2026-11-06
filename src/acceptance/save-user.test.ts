/**
 * save_user（管理画面のユーザー保存）が、メールアドレスの変更時に Slack / Web ログインの紐づけを解除すること。
 * （コードレビュー指摘: 行を別人のメールに付け替えても、前の人の紐づけが残り、前の人が検索し続けられた）
 *
 * 本物の Supabase に対して動かすので、普段の `npm test` ではスキップされる。
 * 実行: RUN_ACCEPTANCE=1 npx vitest run src/acceptance/save-user.test.ts
 * テスト用のユーザー（users と Auth）は終了時に必ず消す。
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

try {
  process.loadEnvFile(".env.local");
} catch {
  // .env.local が無い環境では、環境変数がすでに設定されているものとする
}

const enabled = process.env.RUN_ACCEPTANCE === "1" && !!process.env.SUPABASE_SERVICE_ROLE_KEY;

describe.skipIf(!enabled)("save_user: メール変更時の紐づけ解除（本物のDB）", () => {
  type Db = import("@supabase/supabase-js").SupabaseClient;
  let db: Db;
  const runId = randomUUID().slice(0, 8);
  const userIds: string[] = [];
  const authIds: string[] = [];

  beforeAll(async () => {
    const { getAdminClient } = await import("../lib/supabase");
    db = getAdminClient();
  });

  afterAll(async () => {
    if (!db) return;
    if (userIds.length) {
      await db.from("user_departments").delete().in("user_id", userIds);
      await db.from("users").delete().in("id", userIds);
    }
    for (const id of authIds) await db.auth.admin.deleteUser(id);
  }, 60_000);

  /** 部署1に所属し、Slack とログインが紐づいた仮ユーザーを作る */
  async function linkedUser(label: string) {
    const email = `ac-test-${runId}-${label}@example.invalid`;
    const created = await db.rpc("save_user", { p_id: null, p_email: email, p_display_name: "AC-TEST", p_department_ids: [1] });
    if (created.error) throw created.error;
    const id = created.data as string;
    userIds.push(id);

    const auth = await db.auth.admin.createUser({ email, email_confirm: true });
    if (auth.error) throw auth.error;
    authIds.push(auth.data.user.id);

    const link = await db
      .from("users")
      .update({ slack_user_id: `U-AC-${runId}-${label}`, auth_user_id: auth.data.user.id })
      .eq("id", id);
    if (link.error) throw link.error;
    return { id, email, authId: auth.data.user.id, slackId: `U-AC-${runId}-${label}` };
  }

  const row = async (id: string) => {
    const r = await db.from("users").select("email,display_name,slack_user_id,auth_user_id").eq("id", id).single();
    if (r.error) throw r.error;
    return r.data;
  };

  it("メールアドレスを別のものに変えると、Slack とログインの紐づけが外れる（部署は指定どおり置き換わる）", async () => {
    const u = await linkedUser("changed");
    const newEmail = `ac-test-${runId}-changed-new@example.invalid`;
    const r = await db.rpc("save_user", { p_id: u.id, p_email: newEmail, p_display_name: "AC-TEST", p_department_ids: [2] });
    expect(r.error).toBeNull();

    expect(await row(u.id)).toMatchObject({ email: newEmail, slack_user_id: null, auth_user_id: null });
    const deps = await db.from("user_departments").select("department_id").eq("user_id", u.id);
    expect(deps.data).toEqual([{ department_id: 2 }]);
  }, 60_000);

  it("名前や部署だけを変えるときは、紐づけを保つ", async () => {
    const u = await linkedUser("kept");
    const r = await db.rpc("save_user", { p_id: u.id, p_email: u.email, p_display_name: "名前を変更", p_department_ids: [1, 3] });
    expect(r.error).toBeNull();
    expect(await row(u.id)).toMatchObject({ display_name: "名前を変更", slack_user_id: u.slackId, auth_user_id: u.authId });
  }, 60_000);

  it("大文字小文字・前後の空白だけの違いは、同じメールとみなして紐づけを保つ", async () => {
    const u = await linkedUser("case");
    const r = await db.rpc("save_user", {
      p_id: u.id,
      p_email: ` ${u.email.toUpperCase()} `,
      p_display_name: "AC-TEST",
      p_department_ids: [1],
    });
    expect(r.error).toBeNull();
    expect(await row(u.id)).toMatchObject({ slack_user_id: u.slackId, auth_user_id: u.authId });
  }, 60_000);
});
