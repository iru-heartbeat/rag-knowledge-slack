import type { SupabaseClient } from "@supabase/supabase-js";

/** 利用者（管理者）に、そのまま表示してよい入力ミスのエラー。内部の事情を含む通常の例外とは区別する */
export class UserInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserInputError";
  }
}

export type UserInput = { email: string; displayName: string | null; departmentIds: number[] };

export type Department = { id: number; name: string };

export type UserRow = {
  id: string;
  email: string | null;
  displayName: string | null;
  /** Slack アカウントと紐づいているか（初めて Slack で質問したときに自動で紐づく） */
  slackLinked: boolean;
  isAdmin: boolean;
  departmentIds: number[];
};

const MAX_EMAIL = 254;
const MAX_NAME = 100;
const MAX_INT = 2_147_483_647; // DB の int の上限

/** フォームの入力を検査して整える。Slack との照合は小文字で行うので、メールは小文字にそろえて保存する */
export function validateUserInput(form: FormData): UserInput {
  const email = String(form.get("email") ?? "").trim().toLowerCase();
  if (!email || email.length > MAX_EMAIL || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new UserInputError("メールアドレスの形式が正しくありません。");
  }

  const name = String(form.get("displayName") ?? "").trim();
  if (name.length > MAX_NAME) throw new UserInputError(`名前は${MAX_NAME}文字以内で入力してください。`);

  const ids = form.getAll("departmentIds").map((v) => String(v));
  if (!ids.every((v) => /^\d+$/.test(v) && Number(v) <= MAX_INT)) {
    throw new UserInputError("部署の指定が正しくありません。");
  }
  return {
    email,
    displayName: name || null,
    departmentIds: [...new Set(ids.map(Number))],
  };
}

export async function listUsers(db: SupabaseClient): Promise<{ users: UserRow[]; departments: Department[] }> {
  const [departments, users] = await Promise.all([
    db.from("departments").select("id, name").order("id"),
    db
      .from("users")
      .select("id, email, display_name, slack_user_id, is_admin, user_departments(department_id)")
      .order("email"),
  ]);
  for (const r of [departments, users]) {
    if (r.error) throw new Error(`ユーザー一覧の取得に失敗しました: ${r.error.message}`);
  }

  type Raw = {
    id: string;
    email: string | null;
    display_name: string | null;
    slack_user_id: string | null;
    is_admin: boolean;
    user_departments: Array<{ department_id: number }> | null;
  };
  return {
    departments: (departments.data ?? []) as Department[],
    users: ((users.data ?? []) as Raw[]).map((u) => ({
      id: u.id,
      email: u.email,
      displayName: u.display_name,
      slackLinked: Boolean(u.slack_user_id),
      isAdmin: u.is_admin,
      departmentIds: (u.user_departments ?? []).map((d) => d.department_id),
    })),
  };
}

/**
 * ユーザーを新規登録（id=null）または更新し、所属部署を置き換える。
 * 保存は DB 関数 save_user が1つのトランザクションで行う（途中で失敗しても中途半端な状態が残らない）。
 * 部署は権限に直結する。変更は、そのユーザーの次の Slack 検索からすぐ反映される。
 */
export async function saveUser(db: SupabaseClient, id: string | null, input: UserInput): Promise<string> {
  const { data, error } = await db.rpc("save_user", {
    p_id: id,
    p_email: input.email,
    p_display_name: input.displayName,
    p_department_ids: input.departmentIds,
  });
  if (error) {
    if (error.code === "23505") throw new UserInputError("このメールアドレスはすでに登録されています。");
    if (error.code === "23503") throw new UserInputError("存在しない部署が指定されました。");
    if (error.code === "P0002") throw new UserInputError("対象のユーザーが見つかりません。");
    throw new Error(`ユーザーの保存に失敗しました: ${error.message}`);
  }
  return data as string;
}

/** ユーザーを削除する。管理者(is_admin)は、画面からは消せない（誤操作で全員が締め出されるのを防ぐ） */
export async function deleteUser(db: SupabaseClient, id: string): Promise<void> {
  const { data, error } = await db.from("users").delete().eq("id", id).eq("is_admin", false).select("id");
  if (error) throw new Error(`ユーザーの削除に失敗しました: ${error.message}`);
  if (!data || data.length === 0) {
    throw new UserInputError("削除できませんでした（管理者、または存在しないユーザーです）。");
  }
}

/** Slack との紐づけを外す。本人が Slack のアカウントを変えたときなどに使う（次の質問でメールから再び紐づく） */
export async function unlinkSlack(db: SupabaseClient, id: string): Promise<void> {
  const { data, error } = await db.from("users").update({ slack_user_id: null }).eq("id", id).select("id");
  if (error) throw new Error(`Slack の紐づけ解除に失敗しました: ${error.message}`);
  if (!data || data.length === 0) throw new UserInputError("対象のユーザーが見つかりません。");
}
