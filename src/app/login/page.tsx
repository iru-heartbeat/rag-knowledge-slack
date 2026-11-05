import { redirect } from "next/navigation";
import { getCurrentWebUser } from "@/lib/auth/session";
import "../admin/admin.css";
import { login } from "./actions";

export const metadata = { title: "ログイン | ナレッジ検索", robots: { index: false, follow: false } };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  // すでにログイン済みなら、ログイン画面を飛ばす
  if (await getCurrentWebUser()) redirect("/search");
  const { error } = await searchParams;

  return (
    <div className="admin">
      <main>
        <h1>ナレッジ検索 ログイン</h1>
        {error && <p className="alert">メールアドレスまたはパスワードが正しくありません。</p>}
        <form className="login" action={login}>
          <label>
            メールアドレス
            <input type="email" name="email" autoComplete="username" required />
          </label>
          <label>
            パスワード
            <input type="password" name="password" autoComplete="current-password" required />
          </label>
          <button type="submit">ログイン</button>
        </form>
      </main>
    </div>
  );
}
