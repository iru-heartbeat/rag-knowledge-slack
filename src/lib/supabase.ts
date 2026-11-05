// ブラウザ向けのコード（"use client" のコンポーネントなど）から import されたら、ビルド時にエラーにする。
// このファイルは RLS を無視できる service_role の鍵を扱うため、サーバー専用であることを仕組みで保証する
import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { requireEnv } from "./config";

let admin: SupabaseClient | undefined;

/**
 * サーバー専用の管理者クライアント（service_role）。
 * RLS をバイパスできる強力な鍵を使うため、ブラウザ側コードから import しないこと。
 * 権限制御は呼び出し側で match_chunks(p_user_id) などを使って明示的にかける。
 */
export function getAdminClient(): SupabaseClient {
  admin ??= createClient(
    requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
    requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { persistSession: false } },
  );
  return admin;
}
