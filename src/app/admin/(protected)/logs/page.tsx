import { loadQueryLogs } from "@/lib/admin/queries";
import { requireAdmin } from "@/lib/auth/session";
import { getAdminClient } from "@/lib/supabase";

// 常に最新の状態を表示する（キャッシュしない）
export const dynamic = "force-dynamic";

const CHANNEL_LABEL = { slack: "Slack", web: "Web" } as const;

const fmt = (iso: string) => new Date(iso).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", hour12: false });

export default async function LogsPage() {
  // レイアウトでも確認しているが、画面遷移ではレイアウトが再実行されないため、ここでも必ず確認する
  await requireAdmin();
  const logs = await loadQueryLogs(getAdminClient());

  return (
    <main>
      <h1>質問ログ</h1>
      <p className="muted">
        直近{logs.length}件です。質問と回答の内容は、質問者本人と管理者だけが見られる情報として扱ってください。
        Web 検索は回答文を作らないため、回答欄は「-」になります。
      </p>
      {logs.length === 0 ? (
        <p className="empty">まだ質問はありません。</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>日時</th>
              <th>質問者</th>
              <th>経路</th>
              <th>質問</th>
              <th>回答</th>
              <th>根拠</th>
              <th>所要</th>
            </tr>
          </thead>
          <tbody>
            {logs.map((l) => (
              <tr key={l.id}>
                <td>{fmt(l.createdAt)}</td>
                <td>{l.userLabel}</td>
                <td>{CHANNEL_LABEL[l.channel] ?? l.channel}</td>
                <td>{l.question}</td>
                <td>
                  {l.answer ? (
                    <details>
                      <summary>{l.answer.replace(/\s+/g, " ").slice(0, 60)}…</summary>
                      <div style={{ whiteSpace: "pre-wrap" }}>{l.answer}</div>
                    </details>
                  ) : l.channel === "web" ? (
                    "-"
                  ) : (
                    <span className="muted">未記録（処理中、または失敗）</span>
                  )}
                </td>
                <td>{l.sourceCount}件</td>
                <td>{l.latencyMs === null ? "-" : `${(l.latencyMs / 1000).toFixed(1)}秒`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
