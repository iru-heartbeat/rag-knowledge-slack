import { requireUser } from "@/lib/auth/session";
import { completeQuery, reserveQuery } from "@/lib/quota";
import { retrieveChunks, type RetrievedChunk } from "@/lib/rag/retrieve";
import { getAdminClient } from "@/lib/supabase";
import { parseSearchParams, safeHref } from "@/lib/web/params";
import { listUserDepartments } from "@/lib/web/user";

export const dynamic = "force-dynamic";

const RESULT_COUNT = 20;
const EXCERPT_CHARS = 220;

/** 上限を超えたことを、通常の失敗と区別して伝えるための目印 */
class QuotaExceeded extends Error {}

type SP = Record<string, string | string[] | undefined>;
const val = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

export default async function SearchPage({ searchParams }: { searchParams: Promise<SP> }) {
  // レイアウトでも確認しているが、画面遷移ではレイアウトが再実行されないため、ここでも必ず確認する
  const me = await requireUser();
  const db = getAdminClient();
  const sp = await searchParams;

  const departments = await listUserDepartments(db, me.userId);
  const parsed = parseSearchParams(sp, departments.map((d) => d.id));

  let results: RetrievedChunk[] | null = null;
  let failed = false;
  let overQuota = false;
  if (parsed.kind === "ok") {
    const startedAt = Date.now();
    try {
      // 検索（OpenAI の呼び出し）を始める前に質問を記録して、1時間あたりの上限を確かめる。失敗した検索も数えられる
      const logId = await reserveQuery(db, { userId: me.userId, channel: "web", question: parsed.question });
      if (logId === null) {
        overQuota = true;
        throw new QuotaExceeded();
      }
      // 権限の絞り込みは match_chunks が、ログイン中のユーザーのIDで必ず行う（URL の条件では広げられない）
      results = await retrieveChunks(db, {
        userId: me.userId,
        question: parsed.question,
        filters: parsed.filters,
        topK: RESULT_COUNT,
      });
      // 結果の記録（失敗しても検索結果は返す）
      await completeQuery(db, logId, {
        answer: null,
        sourceChunkIds: results.map((r) => r.chunkId),
        latencyMs: Date.now() - startedAt,
      }).catch((e) => console.error("質問ログの保存に失敗しました:", e));
    } catch (e) {
      if (!(e instanceof QuotaExceeded)) {
        console.error("Web 検索に失敗しました:", e);
        failed = true;
      }
    }
  }

  return (
    <main>
      <h1>文書を検索する</h1>
      <form className="login" method="get" style={{ maxWidth: 560 }}>
        <label>
          検索語（キーワードでも、文章での質問でも）
          <input type="text" name="q" defaultValue={val(sp.q)} maxLength={1000} required />
        </label>
        <label>
          部署
          <select name="dept" defaultValue={val(sp.dept)}>
            <option value="">すべて（閲覧できる範囲）</option>
            {departments.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          客先（一部でも可）
          <input type="text" name="customer" defaultValue={val(sp.customer)} maxLength={100} />
        </label>
        <div style={{ display: "flex", gap: 12 }}>
          <label>
            作成日（から）
            <input type="date" name="from" defaultValue={val(sp.from)} />
          </label>
          <label>
            作成日（まで）
            <input type="date" name="to" defaultValue={val(sp.to)} />
          </label>
        </div>
        <button type="submit">検索</button>
      </form>

      {parsed.kind === "error" && <p className="alert" style={{ marginTop: 16 }}>{parsed.message}</p>}
      {overQuota && <p className="alert" style={{ marginTop: 16 }}>短い間に検索が続いたため、しばらく時間をおいてからもう一度お試しください。</p>}
      {failed && <p className="alert" style={{ marginTop: 16 }}>検索中にエラーが発生しました。時間をおいてもう一度お試しください。</p>}

      {results && (
        <>
          <h2>検索結果（{results.length}件）</h2>
          {results.length === 0 ? (
            <p className="empty">
              関連する文書が見つかりませんでした。キーワードや条件を変えてお試しください。（閲覧権限のある文書の中から探しています）
            </p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>文書</th>
                  <th>該当セクション</th>
                  <th>抜粋</th>
                  <th>客先・作成</th>
                </tr>
              </thead>
              <tbody>
                {results.map((r) => {
                  const href = safeHref(r.url);
                  return (
                    <tr key={r.chunkId}>
                      <td>{href ? <a href={href} target="_blank" rel="noopener noreferrer">{r.title}</a> : r.title}</td>
                      <td>{r.sectionTitle ?? "-"}</td>
                      <td>{excerpt(r.content)}</td>
                      <td>
                        {r.customer ?? "-"}
                        <br />
                        <span className="muted">{r.docDate ?? (r.docYear ? `${r.docYear}年` : "-")}</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </>
      )}
    </main>
  );
}

/** 抜粋。改行を詰めて、長い場合は切る（先頭行にはセクション見出しが入っているので、それは除く） */
function excerpt(content: string): string {
  const flat = content.replace(/\s+/g, " ").trim();
  return flat.length <= EXCERPT_CHARS ? flat : flat.slice(0, EXCERPT_CHARS) + "…";
}
