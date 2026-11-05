import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Slack のユーザーを、このシステムのユーザー(users.id)に結びつける。
 * 部署（=見てよい文書）は users.id から決まるので、ここが権限の入口になる。
 *
 * 1. すでに紐づけ済み(users.slack_user_id)ならそれを使う
 * 2. 未紐づけなら、Slack に登録されたメールアドレスで users を探し、初回だけ紐づける
 * 3. 見つからない・曖昧・失敗のときは null（=検索させない）。権限の付けすぎを避けるため、迷ったら拒否する
 *
 * users.email は小文字で登録する運用とし、比較の側も小文字にそろえる。
 */
export async function resolveUserId(
  db: SupabaseClient,
  slackUserId: string,
  lookupEmail: (slackUserId: string) => Promise<string | null>,
): Promise<string | null> {
  const linked = await db.from("users").select("id").eq("slack_user_id", slackUserId).maybeSingle();
  if (linked.error) throw new Error(`ユーザーの確認に失敗しました: ${linked.error.message}`);
  if (linked.data) return (linked.data as { id: string }).id;

  const email = (await lookupEmail(slackUserId))?.trim().toLowerCase();
  if (!email) return null;

  const found = await db.from("users").select("id, slack_user_id").eq("email", email).maybeSingle();
  if (found.error) throw new Error(`ユーザーの確認に失敗しました: ${found.error.message}`);
  const user = found.data as { id: string; slack_user_id: string | null } | null;
  if (!user) return null;

  // すでに別の Slack アカウントに紐づいている人を、メールが同じというだけで乗っ取らせない
  if (user.slack_user_id) return null;

  // 「まだ誰とも紐づいていない場合だけ」書き込む（同時に2つのアカウントが来ても片方だけが成功する）
  const linkedNow = await db
    .from("users")
    .update({ slack_user_id: slackUserId })
    .eq("id", user.id)
    .is("slack_user_id", null)
    .select("id")
    .maybeSingle();
  if (linkedNow.error || !linkedNow.data) return null;
  return user.id;
}
