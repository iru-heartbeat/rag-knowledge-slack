/**
 * 受入テスト AC-06: 文書の追加・更新・削除が、次回の同期で反映される。
 *
 * 本物の Supabase と OpenAI（Embedding）を使うので、普段の `npm test` ではスキップされる。
 * 実行: RUN_ACCEPTANCE=1 npx vitest run src/acceptance/ac06.test.ts
 *
 * SharePoint の代わりにローカルの一時フォルダを入手元にする（同期の仕組みは同じ runSync）。
 * 既存の文書や同期の進捗には触れないよう、文書ID（フォルダ内のパス）にテスト専用の接頭辞を付け、
 * 進捗の保存キーも専用にする。終了時にテストの文書・記録・仮ユーザーをすべて消す。
 * Embedding は文書 2〜4 件ぶん（数円未満）。
 */
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

try {
  process.loadEnvFile(".env.local");
} catch {
  // .env.local が無い環境では、環境変数がすでに設定されているものとする
}

const SAMPLES = "テスト用PDF_元ファイル";
const sample = (name: string) => join(SAMPLES, name);
const DOC_STRATEGY = "case7-doc1-strategy-dx-bank.pdf"; // 戦略 / 地方銀行A
const DOC_HR = "case7-doc2-hr-engagement-report.pdf"; // 人事 / 製造業B
const DOC_IT = "case7-doc3-it-cloud-migration.pdf"; // IT / 小売業C
const DOC_SALES = "case7-doc4-sales-proposal-retail.pdf"; // 営業 / 小売チェーンD

const enabled =
  process.env.RUN_ACCEPTANCE === "1" &&
  !!process.env.SUPABASE_SERVICE_ROLE_KEY &&
  !!process.env.OPENAI_API_KEY &&
  existsSync(sample(DOC_STRATEGY));

describe.skipIf(!enabled)("受入テスト AC-06: 同期で追加・更新・削除が反映される（本物のDB）", () => {
  type Db = import("@supabase/supabase-js").SupabaseClient;
  let db: Db;
  let dir = "";
  let userId = "";
  const runId = randomUUID().slice(0, 8);
  const prefix = `ac06-${runId}`;
  const cursorKey = `acceptance:ac06:${runId}`;
  const runIds: number[] = [];
  const A = `${prefix}/a.pdf`;
  const B = `${prefix}/b.pdf`;
  const C = `${prefix}/c.pdf`;
  let departments: { id: number; name: string }[] = [];

  async function sync() {
    const { createLocalFolderSource } = await import("../lib/sources/local");
    const { runSync } = await import("../lib/sync/run");
    const r = await runSync(db, createLocalFolderSource(dir), { cursorKey });
    runIds.push(r.runId);
    return r;
  }

  async function doc(sharepointId: string) {
    const d = await db
      .from("documents")
      .select("id,status,customer,doc_year,content_hash")
      .eq("sharepoint_id", sharepointId)
      .maybeSingle();
    if (d.error) throw d.error;
    if (!d.data) return null;
    const acc = await db.from("document_access").select("department_id").eq("document_id", d.data.id);
    const ch = await db.from("chunks").select("id", { count: "exact", head: true }).eq("document_id", d.data.id);
    const deptNames = (acc.data ?? []).map((a) => departments.find((x) => x.id === a.department_id)!.name).sort();
    return { ...d.data, deptNames, chunkCount: ch.count ?? 0 };
  }

  beforeAll(async () => {
    const { getAdminClient } = await import("../lib/supabase");
    db = getAdminClient();
    dir = await mkdtemp(join(tmpdir(), "ac06-"));
    await mkdir(join(dir, prefix));
    await copyFile(sample(DOC_STRATEGY), join(dir, A));
    await copyFile(sample(DOC_IT), join(dir, B));

    const deps = await db.from("departments").select("id,name");
    if (deps.error) throw deps.error;
    departments = deps.data;

    // 検索から外れたことを確かめるための、全部署に所属する仮ユーザー
    const u = await db
      .from("users")
      .insert({ email: `ac-test-${runId}-sync@example.invalid`, display_name: "AC-TEST 同期" })
      .select("id")
      .single();
    if (u.error) throw u.error;
    userId = u.data.id;
    const links = await db
      .from("user_departments")
      .insert(departments.map((d) => ({ user_id: userId, department_id: d.id })));
    if (links.error) throw links.error;
  }, 60_000);

  afterAll(async () => {
    if (!db) return;
    await db.from("documents").delete().like("sharepoint_id", `${prefix}/%`); // chunks / document_access も連鎖して消える
    if (runIds.length) await db.from("ingestion_runs").delete().in("id", runIds); // ingestion_errors も連鎖して消える
    await db.from("sync_state").delete().eq("key", cursorKey);
    if (userId) {
      await db.from("user_departments").delete().eq("user_id", userId);
      await db.from("query_logs").delete().eq("user_id", userId);
      await db.from("users").delete().eq("id", userId);
    }
    if (dir) await rm(dir, { recursive: true, force: true });
  }, 60_000);

  it("【追加】初回の同期で 2 件が取り込まれ、正しい部署にだけ公開される", async () => {
    const r = await sync();
    expect(r).toMatchObject({ status: "done", total: 2, succeeded: 2, failed: 0, deleted: 0 });

    const a = await doc(A);
    const b = await doc(B);
    expect(a).toMatchObject({ status: "active", customer: "地方銀行A", deptNames: ["戦略"] });
    expect(b).toMatchObject({ status: "active", customer: "小売業C", deptNames: ["IT"] });
    expect(a!.chunkCount).toBeGreaterThan(0);
    expect(b!.chunkCount).toBeGreaterThan(0);
  }, 120_000);

  it("【変更なし】何も変えずに同期しても、取り込み直さず飛ばす（中身が同じなら二重に増えない）", async () => {
    const before = await doc(A);
    const r = await sync();
    expect(r).toMatchObject({ status: "done", total: 2, succeeded: 2, skipped: 2, failed: 0 });
    const after = await doc(A);
    expect(after).toMatchObject({ id: before!.id, content_hash: before!.content_hash, chunkCount: before!.chunkCount });
  }, 120_000);

  it("【更新】ファイルの中身を差し替えると、次回の同期で内容・部署・チャンクが入れ替わる", async () => {
    const before = await doc(A);
    await copyFile(sample(DOC_HR), join(dir, A)); // 同じ場所のファイルを、別の文書の中身にする

    const r = await sync();
    expect(r).toMatchObject({ status: "done", failed: 0 });
    expect(r.skipped).toBe(1); // 変えていない b.pdf は飛ばされ、a.pdf だけが取り込み直される

    const after = await doc(A);
    expect(after!.id).toBe(before!.id); // 別の文書として増えるのではなく、同じ文書が更新される
    expect(after!.content_hash).not.toBe(before!.content_hash);
    expect(after).toMatchObject({ status: "active", customer: "製造業B", deptNames: ["人事"] });
    expect(after!.chunkCount).toBeGreaterThan(0);

    // 旧い内容（戦略部の文書）の権限が残っていないこと
    const a = await db.from("documents").select("id").eq("sharepoint_id", A).single();
    const acc = await db.from("document_access").select("department_id").eq("document_id", a.data!.id);
    expect(acc.data).toHaveLength(1);
  }, 120_000);

  it("【追加】新しいファイルを置くと、次回の同期で増える", async () => {
    await copyFile(sample(DOC_SALES), join(dir, C));
    const r = await sync();
    expect(r).toMatchObject({ status: "done", failed: 0 });
    expect(await doc(C)).toMatchObject({ status: "active", customer: "小売チェーンD", deptNames: ["営業"] });
  }, 120_000);

  it("【削除】ファイルを消すと、次回の同期で検索対象から外れる", async () => {
    const b = await doc(B);
    const chunk = await db.from("chunks").select("embedding").eq("document_id", b!.id).limit(1).single();
    const search = async () => {
      const { data, error } = await db.rpc("match_chunks", {
        query_embedding: chunk.data!.embedding,
        p_user_id: userId,
        match_count: 20,
      });
      if (error) throw error;
      return (data as { document_id: string }[]).map((r) => r.document_id);
    };
    expect(await search(), "削除前は検索に出る（前提の確認）").toContain(b!.id);

    await rm(join(dir, B));
    const r = await sync();
    expect(r).toMatchObject({ status: "done", deleted: 1, failed: 0 });

    expect((await doc(B))!.status).toBe("deleted");
    expect(await search(), "削除後は、全部署に所属する人の検索にも出ない").not.toContain(b!.id);
    expect(await doc(A)).toMatchObject({ status: "active" }); // 残したファイルは影響を受けない
  }, 120_000);

  it("【記録】各回の同期結果が ingestion_runs に残り、管理者が確認できる", async () => {
    const { data, error } = await db.from("ingestion_runs").select("id,status,total,succeeded,failed").in("id", runIds);
    if (error) throw error;
    expect(data).toHaveLength(runIds.length);
    for (const run of data!) expect(run.status).toBe("done");
  });
});
