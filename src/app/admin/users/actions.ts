"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { deleteUser, saveUser, unlinkSlack, UserInputError, validateUserInput } from "@/lib/admin/users";
import { requireAdmin } from "@/lib/auth/session";
import { getAdminClient } from "@/lib/supabase";

/** 画面に返す結果。成功時は画面遷移するので、ここに来るのは入力ミスの表示だけ */
export type FormState = { error?: string } | null;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 操作(Server Action)は、画面を経由せずに直接呼ばれることもある。
 * 画面側の確認に頼らず、どの操作もここで必ず管理者かどうかを確かめる。
 */
async function guarded<T>(fn: () => Promise<T>): Promise<T | { error: string }> {
  await requireAdmin();
  try {
    return await fn();
  } catch (e) {
    // 利用者向けの入力エラーだけを画面に出す。それ以外（DB の詳細など）は画面に漏らさない
    if (e instanceof UserInputError) return { error: e.message };
    console.error("ユーザー管理の操作に失敗しました:", e);
    return { error: "エラーが発生しました。時間をおいてもう一度お試しください。" };
  }
}

export async function saveUserAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const rawId = String(formData.get("id") ?? "");
  const result = await guarded(async () => {
    if (rawId && !UUID.test(rawId)) throw new UserInputError("対象のユーザーが正しくありません。");
    await saveUser(getAdminClient(), rawId || null, validateUserInput(formData));
    return null;
  });
  if (result) return result;
  revalidatePath("/admin/users");
  redirect("/admin/users");
}

export async function deleteUserAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const id = String(formData.get("id") ?? "");
  const result = await guarded(async () => {
    if (!UUID.test(id)) throw new UserInputError("対象のユーザーが正しくありません。");
    await deleteUser(getAdminClient(), id);
    return null;
  });
  if (result) return result;
  revalidatePath("/admin/users");
  redirect("/admin/users");
}

export async function unlinkSlackAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const id = String(formData.get("id") ?? "");
  const result = await guarded(async () => {
    if (!UUID.test(id)) throw new UserInputError("対象のユーザーが正しくありません。");
    await unlinkSlack(getAdminClient(), id);
    return null;
  });
  if (result) return result;
  revalidatePath("/admin/users");
  redirect("/admin/users");
}
