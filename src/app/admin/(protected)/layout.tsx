import type { ReactNode } from "react";
import { requireAdmin } from "@/lib/auth/session";
import { logout } from "../actions";

export default async function ProtectedLayout({ children }: { children: ReactNode }) {
  const admin = await requireAdmin();
  return (
    <>
      <div className="bar">
        <nav>
          <strong>ナレッジ検索 管理</strong>
          <a href="/admin">ダッシュボード</a>
          <a href="/admin/logs">質問ログ</a>
          <a href="/admin/users">ユーザー</a>
        </nav>
        <form action={logout}>
          <span className="muted">{admin.email} </span>
          <button className="link" type="submit">
            ログアウト
          </button>
        </form>
      </div>
      {children}
    </>
  );
}
