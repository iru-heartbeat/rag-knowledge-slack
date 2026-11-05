"use server";

import { redirect } from "next/navigation";
import { createAuthClient } from "@/lib/auth/session";
import { getAdminClient } from "@/lib/supabase";
import { resolveWebUser } from "@/lib/web/user";

/**
 * 一般ユーザーのログイン。メールとパスワードを確かめ、さらに users に登録された人であることも確かめる。
 * 失敗の理由（メールが無い／パスワード違い／未登録）は区別せず、同じ表示にする（登録済みのメールを推測されないため）。
 */
export async function login(formData: FormData): Promise<void> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  if (!email || !password) redirect("/login?error=1");

  const auth = await createAuthClient();
  const { data, error } = await auth.auth.signInWithPassword({ email, password });
  if (error || !data.user) redirect("/login?error=1");

  const user = await resolveWebUser(getAdminClient(), {
    id: data.user.id,
    email: data.user.email ?? null,
    emailConfirmed: Boolean(data.user.email_confirmed_at),
  });
  if (!user) {
    await auth.auth.signOut(); // 未登録の人のログイン状態を残さない
    redirect("/login?error=1");
  }
  redirect("/search");
}

export async function logout(): Promise<void> {
  const auth = await createAuthClient();
  await auth.auth.signOut();
  redirect("/login");
}
