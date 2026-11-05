"use client";

import { useActionState } from "react";
import type { Department, UserRow } from "@/lib/admin/users";
import { deleteUserAction, saveUserAction, unlinkSlackAction, type FormState } from "./actions";

/** 登録・編集の共通フォーム。user があれば編集 */
export function UserForm({ departments, user }: { departments: Department[]; user?: UserRow }) {
  const [state, action, pending] = useActionState<FormState, FormData>(saveUserAction, null);

  return (
    <form className="login" action={action}>
      {user && <input type="hidden" name="id" value={user.id} />}
      <label>
        メールアドレス（Slack に登録されているものと同じ）
        <input type="email" name="email" defaultValue={user?.email ?? ""} required />
      </label>
      <label>
        名前（任意）
        <input type="text" name="displayName" defaultValue={user?.displayName ?? ""} maxLength={100} />
      </label>
      <fieldset>
        <legend>閲覧できる部署</legend>
        {departments.map((d) => (
          <label key={d.id} className="check">
            <input
              type="checkbox"
              name="departmentIds"
              value={d.id}
              defaultChecked={user?.departmentIds.includes(d.id)}
            />
            {d.name}
          </label>
        ))}
        <p className="muted">チェックした部署の文書だけが、この人の検索結果に出ます。変更はすぐ反映されます。</p>
      </fieldset>
      {state?.error && <p className="alert">{state.error}</p>}
      <button type="submit" disabled={pending}>
        {user ? "更新する" : "登録する"}
      </button>
    </form>
  );
}

/** 削除・紐づけ解除のような取り消しにくい操作のボタン（確認ダイアログつき） */
export function DangerForm({
  kind,
  id,
  label,
  confirmMessage,
}: {
  kind: "delete" | "unlink";
  id: string;
  label: string;
  confirmMessage: string;
}) {
  const [state, action, pending] = useActionState<FormState, FormData>(
    kind === "delete" ? deleteUserAction : unlinkSlackAction,
    null,
  );
  return (
    <form
      action={action}
      onSubmit={(e) => {
        if (!window.confirm(confirmMessage)) e.preventDefault();
      }}
    >
      <input type="hidden" name="id" value={id} />
      {state?.error && <p className="alert">{state.error}</p>}
      <button className="danger" type="submit" disabled={pending}>
        {label}
      </button>
    </form>
  );
}
