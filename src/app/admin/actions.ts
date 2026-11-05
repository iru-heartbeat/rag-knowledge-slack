"use server";

import { redirect } from "next/navigation";
import { findAdminUser } from "@/lib/admin/queries";
import { createAuthClient } from "@/lib/auth/session";
import { getAdminClient } from "@/lib/supabase";

/**
 * ログイン。メールアドレスとパスワードを Supabase Auth で確かめ、さらに管理者であることも確かめる。
 * 失敗の理由（メールが無い／パスワード違い／管理者でない）は区別せず、同じ表示にする。
 * 区別すると、どのメールアドレスが登録されているかを外部の人に推測されてしまうため。
 */
export async function login(formData: FormData): Promise<void> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  if (!email || !password) redirect("/admin/login?error=1");

  const auth = await createAuthClient();
  const { data, error } = await auth.auth.signInWithPassword({ email, password });
  if (error || !data.user) redirect("/admin/login?error=1");

  const admin = await findAdminUser(getAdminClient(), data.user.id);
  if (!admin) {
    await auth.auth.signOut(); // 管理者でない人のログイン状態を残さない
    redirect("/admin/login?error=1");
  }
  redirect("/admin");
}

export async function logout(): Promise<void> {
  const auth = await createAuthClient();
  await auth.auth.signOut();
  redirect("/admin/login");
}
