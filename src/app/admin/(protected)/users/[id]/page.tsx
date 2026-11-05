import { notFound } from "next/navigation";
import { listUsers } from "@/lib/admin/users";
import { requireAdmin } from "@/lib/auth/session";
import { getAdminClient } from "@/lib/supabase";
import { DangerForm, UserForm } from "../../../users/forms";

export const dynamic = "force-dynamic";

export default async function EditUserPage({ params }: { params: Promise<{ id: string }> }) {
  await requireAdmin();
  const { id } = await params;
  const { users, departments } = await listUsers(getAdminClient());
  const user = users.find((u) => u.id === id);
  if (!user) notFound();

  return (
    <main>
      <p>
        <a href="/admin/users">← ユーザー一覧</a>
      </p>
      <h1>{user.email} を編集</h1>
      {user.isAdmin && <p className="muted">管理者です。管理者の追加・解除や削除は、この画面からはできません。</p>}

      <UserForm departments={departments} user={user} />

      <h2>Slack との紐づけ</h2>
      <p className="muted">
        現在: {user.slackLinked ? "紐づけ済み" : "未（初めて Slack で質問したときに、メールアドレスから自動で結びつきます）"}
      </p>
      {user.slackLinked && (
        <DangerForm
          kind="unlink"
          id={user.id}
          label="紐づけを外す"
          confirmMessage="Slack との紐づけを外します。次に質問したとき、メールアドレスから再び結びつきます。よろしいですか？"
        />
      )}

      {!user.isAdmin && (
        <>
          <h2>削除</h2>
          <DangerForm
            kind="delete"
            id={user.id}
            label="このユーザーを削除する"
            confirmMessage="このユーザーを削除します。Slack で検索できなくなります。よろしいですか？"
          />
        </>
      )}
    </main>
  );
}
