import { redirect } from "next/navigation";
import { getCurrentAdmin } from "@/lib/auth/session";
import { login } from "../actions";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  // すでにログイン済みの管理者は、ログイン画面を飛ばす
  if (await getCurrentAdmin()) redirect("/admin");
  const { error } = await searchParams;

  return (
    <main>
      <h1>管理画面ログイン</h1>
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
  );
}
