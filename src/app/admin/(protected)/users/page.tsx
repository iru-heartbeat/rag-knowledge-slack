import { listUsers } from "@/lib/admin/users";
import { requireAdmin } from "@/lib/auth/session";
import { getAdminClient } from "@/lib/supabase";
import { UserForm } from "../../users/forms";

export const dynamic = "force-dynamic";

export default async function UsersPage() {
  await requireAdmin();
  const { users, departments } = await listUsers(getAdminClient());
  const deptName = new Map(departments.map((d) => [d.id, d.name]));

  return (
    <main>
      <h1>ユーザーと閲覧できる部署</h1>
      <p className="muted">
        ここに登録された人だけが、Slack で検索できます。Slack に登録されたメールアドレスと一致する人が、初めて質問したときに自動で結びつきます。
      </p>

      <table>
        <thead>
          <tr>
            <th>メールアドレス</th>
            <th>名前</th>
            <th>閲覧できる部署</th>
            <th>Slack</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id}>
              <td>
                {u.email}
                {u.isAdmin && <span className="badge done"> 管理者</span>}
              </td>
              <td>{u.displayName ?? "-"}</td>
              <td>
                {u.departmentIds.length === 0
                  ? "なし（検索しても何も出ません）"
                  : u.departmentIds.map((id) => deptName.get(id) ?? id).join("、")}
              </td>
              <td>{u.slackLinked ? "紐づけ済み" : "未"}</td>
              <td>
                <a href={`/admin/users/${u.id}`}>編集</a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>ユーザーを登録する</h2>
      <UserForm departments={departments} />
    </main>
  );
}
