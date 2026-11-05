import type { ReactNode } from "react";
import "./admin.css";

// 管理画面は検索エンジンに載せない
export const metadata = { title: "管理画面 | ナレッジ検索", robots: { index: false, follow: false } };

export default function AdminRootLayout({ children }: { children: ReactNode }) {
  return <div className="admin">{children}</div>;
}
