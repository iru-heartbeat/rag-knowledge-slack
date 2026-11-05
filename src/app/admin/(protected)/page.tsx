import { loadDashboard } from "@/lib/admin/queries";
import { requireAdmin } from "@/lib/auth/session";
import { getAdminClient } from "@/lib/supabase";

// 常に最新の状態を表示する（キャッシュしない）
export const dynamic = "force-dynamic";

const STATUS_LABEL: Record<string, string> = {
  running: "実行中",
  partial: "一部失敗/途中",
  done: "完了",
  error: "エラー",
};

const fmt = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", hour12: false }) : "-";

export default async function DashboardPage() {
  // レイアウトでも確認しているが、画面遷移ではレイアウトが再実行されないため、ここでも必ず確認する
  await requireAdmin();
  const { runs, errors, unassigned } = await loadDashboard(getAdminClient());

  return (
    <main>
      <h1>ダッシュボード</h1>

      <h2>最近の同期</h2>
      {runs.length === 0 ? (
        <p className="empty">まだ同期は実行されていません。</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>開始</th>
              <th>状態</th>
              <th>対象</th>
              <th>成功</th>
              <th>失敗</th>
              <th>終了</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.id}>
                <td>{fmt(r.started_at)}</td>
                <td>
                  <span className={`badge ${r.status}`}>{STATUS_LABEL[r.status] ?? r.status}</span>
                </td>
                <td>{r.total ?? 0}</td>
                <td>{r.succeeded ?? 0}</td>
                <td>{r.failed ?? 0}</td>
                <td>{fmt(r.finished_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>部署が判定できず、誰にも見えない文書（{unassigned.length}件）</h2>
      <p className="muted">
        文書の冒頭に部署の記載がない、または登録された部署名と一致しなかった文書です。権限の付けすぎを避けるため、
        確認されるまで誰の検索にも出ません。
      </p>
      {unassigned.length === 0 ? (
        <p className="empty">該当する文書はありません。</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>文書名</th>
              <th>客先</th>
              <th>作成年</th>
              <th>取り込み日時</th>
            </tr>
          </thead>
          <tbody>
            {unassigned.map((d) => (
              <tr key={d.id}>
                <td>{d.title}</td>
                <td>{d.customer ?? "-"}</td>
                <td>{d.doc_year ?? "-"}</td>
                <td>{fmt(d.synced_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>取り込みの失敗（直近{errors.length}件）</h2>
      {errors.length === 0 ? (
        <p className="empty">失敗の記録はありません。</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>日時</th>
              <th>文書</th>
              <th>理由</th>
            </tr>
          </thead>
          <tbody>
            {errors.map((e) => (
              <tr key={e.id}>
                <td>{fmt(e.created_at)}</td>
                <td>{e.title ?? e.sharepoint_id ?? "-"}</td>
                <td>{e.error_message ?? "-"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
