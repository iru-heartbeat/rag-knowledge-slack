import type { ReactNode } from "react";
import { requireUser } from "@/lib/auth/session";
import { logout } from "../login/actions";
import "../admin/admin.css";

export const metadata = { title: "検索 | ナレッジ検索", robots: { index: false, follow: false } };

export default async function SearchLayout({ children }: { children: ReactNode }) {
  const user = await requireUser();
  return (
    <div className="admin">
      <div className="bar">
        <nav>
          <strong>ナレッジ検索</strong>
        </nav>
        <form action={logout}>
          <span className="muted">{user.email} </span>
          <button className="link" type="submit">
            ログアウト
          </button>
        </form>
      </div>
      {children}
    </div>
  );
}
