import { redirect } from "next/navigation";

// トップは検索画面へ。ログインしていなければ、検索画面がログイン画面へ転送する
export default function Home() {
  redirect("/search");
}
