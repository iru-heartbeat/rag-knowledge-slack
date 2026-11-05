import type { SupabaseClient } from "@supabase/supabase-js";

export type WebUser = { userId: string; email: string | null };

/** ログイン中のアカウント（Supabase Auth のユーザー）のうち、判定に使う項目 */
export type AuthAccount = { id: string; email: string | null; emailConfirmed: boolean };

/**
 * ログインしたアカウントを、このシステムのユーザー(users)に結びつける。部署（=見てよい文書）は users から決まる。
 *  1. すでに紐づけ済み(users.auth_user_id)ならそれを使う
 *  2. 未紐づけなら、確認済みのメールアドレスで users を探し、初回だけ紐づける
 *  3. 見つからない・曖昧・失敗は null（=検索させない）。権限の付けすぎを避けるため、迷ったら拒否する
 * Slack 側(slack/user.ts)と同じ考え方。users.email は小文字で登録する運用。
 */
export async function resolveWebUser(db: SupabaseClient, account: AuthAccount): Promise<WebUser | null> {
  const linked = await db.from("users").select("id, email").eq("auth_user_id", account.id).maybeSingle();
  if (linked.error) throw new Error(`ユーザーの確認に失敗しました: ${linked.error.message}`);
  if (linked.data) {
    const row = linked.data as { id: string; email: string | null };
    return { userId: row.id, email: row.email };
  }

  // メールが未確認のアカウントは、他人のメールアドレスを名乗れてしまう。メールの一致だけでは紐づけない
  const email = account.email?.trim().toLowerCase();
  if (!account.emailConfirmed || !email) return null;

  const found = await db.from("users").select("id, email, auth_user_id").eq("email", email).maybeSingle();
  if (found.error) throw new Error(`ユーザーの確認に失敗しました: ${found.error.message}`);
  const user = found.data as { id: string; email: string | null; auth_user_id: string | null } | null;
  if (!user) return null;

  // すでに別のアカウントに紐づいている人を、メールが同じというだけで乗っ取らせない
  if (user.auth_user_id) return null;

  // 「まだ誰とも紐づいていない場合だけ」書き込む（同時に2つのアカウントが来ても片方だけが成功する）
  const linkedNow = await db
    .from("users")
    .update({ auth_user_id: account.id })
    .eq("id", user.id)
    .is("auth_user_id", null)
    .select("id")
    .maybeSingle();
  if (linkedNow.error || !linkedNow.data) return null;
  return { userId: user.id, email: user.email };
}

/** ユーザーの所属部署（検索の絞り込みの選択肢に使う） */
export async function listUserDepartments(
  db: SupabaseClient,
  userId: string,
): Promise<Array<{ id: number; name: string }>> {
  const { data, error } = await db.from("user_departments").select("departments(id, name)").eq("user_id", userId);
  if (error) throw new Error(`所属部署の取得に失敗しました: ${error.message}`);

  type D = { id: number; name: string };
  const rows = (data ?? []) as Array<{ departments: D | D[] | null }>;
  return rows
    .flatMap((r) => (Array.isArray(r.departments) ? r.departments : r.departments ? [r.departments] : []))
    .sort((a, b) => a.id - b.id);
}
