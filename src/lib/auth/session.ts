import "server-only";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { findAdminUser, type AdminUser } from "../admin/queries";
import { requireEnv } from "../config";
import { resolveWebUser, type WebUser } from "../web/user";
import { getAdminClient } from "../supabase";

/**
 * ログイン状態（Cookie）を読み書きするクライアント。anon キーを使うので、これ自身は RLS の制限を受ける。
 * データの読み書きには使わず、「誰がログインしているか」の確認と、ログイン・ログアウトだけに使う。
 */
export async function createAuthClient() {
  const store = await cookies();
  return createServerClient(requireEnv("NEXT_PUBLIC_SUPABASE_URL"), requireEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY"), {
    cookies: {
      getAll: () => store.getAll(),
      setAll: (list) => {
        try {
          for (const { name, value, options } of list) store.set(name, value, options);
        } catch {
          // 画面(Server Component)の中では Cookie を書けない。更新は middleware が行う
        }
      },
    },
  });
}

/**
 * 今ログインしている管理者。ログインしていない・管理者でなければ null。
 * getSession() ではなく getUser() を使う: getSession() は Cookie の中身をそのまま信じるが、
 * getUser() は Supabase Auth のサーバーに問い合わせて本物か確かめるため、偽造された Cookie では通らない。
 */
export async function getCurrentAdmin(): Promise<AdminUser | null> {
  const auth = await createAuthClient();
  const { data, error } = await auth.auth.getUser();
  if (error || !data.user) return null;
  return findAdminUser(getAdminClient(), data.user.id);
}

/**
 * 管理者でなければログイン画面へ飛ばす。
 * 管理者向けの「画面」と「操作(Server Action)」の入口で必ず呼ぶこと。
 * レイアウトで一度確認しただけでは足りない（画面遷移ではレイアウトが再実行されない／操作は画面を経由せず直接呼べる）。
 */
export async function requireAdmin(): Promise<AdminUser> {
  const admin = await getCurrentAdmin();
  if (!admin) redirect("/admin/login");
  return admin;
}

/**
 * 今ログインしている一般ユーザー（管理者を含む、users に登録された人）。
 * ログインしていない・users に登録されていなければ null。管理者かどうかは問わない。
 * 確認の仕方は getCurrentAdmin と同じ（getUser() でサーバーに問い合わせる）。
 */
export async function getCurrentWebUser(): Promise<WebUser | null> {
  const auth = await createAuthClient();
  const { data, error } = await auth.auth.getUser();
  if (error || !data.user) return null;
  return resolveWebUser(getAdminClient(), {
    id: data.user.id,
    email: data.user.email ?? null,
    emailConfirmed: Boolean(data.user.email_confirmed_at),
  });
}

/** 登録済みのユーザーでなければログイン画面へ飛ばす。検索画面の入口で必ず呼ぶこと */
export async function requireUser(): Promise<WebUser> {
  const user = await getCurrentWebUser();
  if (!user) redirect("/login");
  return user;
}
