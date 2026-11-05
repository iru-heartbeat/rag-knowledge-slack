/**
 * 受入テスト AC-04（部署ごとの権限分離）・AC-05（該当なしなら創作しない）・AC-07（Web の絞り込みと権限）。
 *
 * 本物の Supabase に対して動かすので、普段の `npm test` では実行しない（スキップされる）。
 * 実行: RUN_ACCEPTANCE=1 npx vitest run src/acceptance   （.env.local を自動で読み込む）
 *
 * テスト用のユーザーを 7 人（6 部署＋部署なし）作り、終了時に必ず消す。既存のデータは変更しない。
 * AC-04 は保存済みチャンクの Embedding をそのまま質問に使うので、外部 API は呼ばない。
 * AC-05 は OpenAI で質問を Embedding にする（数円未満）。Claude は呼ばれないことも確認する。
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

try {
  process.loadEnvFile(".env.local");
} catch {
  // .env.local が無い環境では、環境変数がすでに設定されているものとする
}

const enabled = process.env.RUN_ACCEPTANCE === "1" && !!process.env.SUPABASE_SERVICE_ROLE_KEY;

describe.skipIf(!enabled)("受入テスト AC-04 / AC-05（本物のDB）", () => {
  type Db = import("@supabase/supabase-js").SupabaseClient;
  let db: Db;
  const runId = randomUUID().slice(0, 8);
  const testUsers: { id: string; departmentId: number | null; departmentName: string }[] = [];
  let departments: { id: number; name: string }[] = [];
  /** 全部署に所属するテスト用ユーザー（testUsers とは別扱い。AC-07 用） */
  let allUserId = "";
  /** 文書のメタデータ（AC-07 の期待値を、実データから計算するため） */
  let docMeta: { id: string; title: string; customer: string | null; doc_date: string | null; doc_year: number | null }[] =
    [];
  /** 文書ID → その文書を見てよい部署ID */
  const access = new Map<string, Set<number>>();
  /** 文書ごとの代表チャンクの Embedding（質問の代わりに使う） */
  const probes: { documentId: string; title: string; embedding: string }[] = [];

  beforeAll(async () => {
    const { getAdminClient } = await import("../lib/supabase");
    db = getAdminClient();

    const deps = await db.from("departments").select("id,name").order("id");
    if (deps.error) throw deps.error;
    departments = deps.data;
    expect(departments).toHaveLength(6);

    for (const d of departments) {
      const u = await db
        .from("users")
        .insert({ email: `ac-test-${runId}-${d.id}@example.invalid`, display_name: `AC-TEST ${d.name}` })
        .select("id")
        .single();
      if (u.error) throw u.error;
      const link = await db.from("user_departments").insert({ user_id: u.data.id, department_id: d.id });
      if (link.error) throw link.error;
      testUsers.push({ id: u.data.id, departmentId: d.id, departmentName: d.name });
    }
    // 全部署に所属する人（AC-07 で、権限に邪魔されずに絞り込みだけを確かめる用）
    const all = await db
      .from("users")
      .insert({ email: `ac-test-${runId}-all@example.invalid`, display_name: "AC-TEST 全部署" })
      .select("id")
      .single();
    if (all.error) throw all.error;
    const allLinks = await db
      .from("user_departments")
      .insert(departments.map((d) => ({ user_id: all.data.id, department_id: d.id })));
    if (allLinks.error) throw allLinks.error;
    allUserId = all.data.id;

    // 部署に所属しない人
    const none = await db
      .from("users")
      .insert({ email: `ac-test-${runId}-none@example.invalid`, display_name: "AC-TEST 部署なし" })
      .select("id")
      .single();
    if (none.error) throw none.error;
    testUsers.push({ id: none.data.id, departmentId: null, departmentName: "部署なし" });

    const acc = await db.from("document_access").select("document_id,department_id");
    if (acc.error) throw acc.error;
    for (const a of acc.data) {
      if (!access.has(a.document_id)) access.set(a.document_id, new Set());
      access.get(a.document_id)!.add(a.department_id);
    }

    const docs = await db.from("documents").select("id,title,customer,doc_date,doc_year");
    if (docs.error) throw docs.error;
    docMeta = docs.data;
    for (const doc of docs.data) {
      const ch = await db.from("chunks").select("embedding").eq("document_id", doc.id).limit(1).single();
      if (ch.error) throw ch.error;
      probes.push({ documentId: doc.id, title: doc.title, embedding: ch.data.embedding as unknown as string });
    }
  }, 60_000);

  afterAll(async () => {
    if (!db || testUsers.length === 0) return;
    const ids = [...testUsers.map((u) => u.id), ...(allUserId ? [allUserId] : [])];
    await db.from("user_departments").delete().in("user_id", ids);
    await db.from("query_logs").delete().in("user_id", ids);
    await db.from("users").delete().in("id", ids);
  }, 60_000);

  async function search(userId: string, embedding: string) {
    const { data, error } = await db.rpc("match_chunks", {
      query_embedding: embedding,
      p_user_id: userId,
      match_count: 20,
    });
    if (error) throw error;
    return data as { document_id: string; title: string }[];
  }

  describe("AC-04: 他部署の文書を根拠にしない（6部署）", () => {
    it("サンプルの文書は、どれか1つ以上の部署にだけ公開されている（前提の確認）", () => {
      expect(probes.length).toBeGreaterThan(0);
      for (const p of probes) {
        expect(access.get(p.documentId)?.size ?? 0, `${p.title} の公開先`).toBeGreaterThan(0);
        expect(access.get(p.documentId)!.size, `${p.title} が全部署に公開されていない`).toBeLessThan(6);
      }
    });

    it("どの部署のユーザーも、どの文書の内容で質問しても、自部署に公開された文書しか返らない", async () => {
      const violations: string[] = [];
      for (const user of testUsers.filter((u) => u.departmentId !== null)) {
        for (const probe of probes) {
          const rows = await search(user.id, probe.embedding);
          for (const r of rows) {
            if (!access.get(r.document_id)?.has(user.departmentId!)) {
              violations.push(`${user.departmentName} のユーザーに ${r.title} が返った`);
            }
          }
        }
      }
      expect(violations).toEqual([]);
    }, 120_000);

    it("文書の公開先の部署のユーザーには、その文書がちゃんと返る（権限を絞りすぎていない）", async () => {
      for (const probe of probes) {
        for (const user of testUsers) {
          if (user.departmentId === null || !access.get(probe.documentId)!.has(user.departmentId)) continue;
          const rows = await search(user.id, probe.embedding);
          expect(rows.map((r) => r.document_id), `${user.departmentName} × ${probe.title}`).toContain(probe.documentId);
        }
      }
    }, 120_000);

    it("文書が1件も公開されていない部署のユーザーには、何も返らない", async () => {
      const covered = new Set([...access.values()].flatMap((s) => [...s]));
      const empty = testUsers.filter((u) => u.departmentId !== null && !covered.has(u.departmentId));
      for (const user of empty) {
        for (const probe of probes) expect(await search(user.id, probe.embedding), user.departmentName).toEqual([]);
      }
    }, 120_000);

    it("どの部署にも所属しないユーザーには、何も返らない", async () => {
      const user = testUsers.find((u) => u.departmentId === null)!;
      for (const probe of probes) expect(await search(user.id, probe.embedding)).toEqual([]);
    }, 60_000);

    it("存在しないユーザーIDでは、何も返らない（権限を付けない側に倒れる）", async () => {
      for (const probe of probes) expect(await search(randomUUID(), probe.embedding)).toEqual([]);
    }, 60_000);
  });

  describe("AC-07: Web詳細検索の絞り込み（部署・客先・日付）と権限", () => {
    type F = { departmentId?: number; customer?: string; dateFrom?: string; dateTo?: string };

    /** Web 検索と同じ経路（retrieveChunks → match_chunks）。質問は文書のチャンクの Embedding で代用する */
    async function webSearch(userId: string, probe: (typeof probes)[number], filters: F) {
      const { retrieveChunks } = await import("../lib/rag/retrieve");
      const chunks = await retrieveChunks(
        db,
        { userId, question: probe.title, filters, topK: 20 },
        { embed: async () => JSON.parse(probe.embedding) as number[] },
      );
      return new Set(chunks.map((c) => c.documentId));
    }

    /** match_chunks の規則（年月日がある文書は日付で、年だけの文書は年で比較）を、実データから計算した期待値 */
    function matches(doc: (typeof docMeta)[number], f: F): boolean {
      if (f.customer && !(doc.customer ?? "").toLowerCase().includes(f.customer.toLowerCase())) return false;
      const yearOf = (s: string) => Number(s.slice(0, 4));
      if (f.dateFrom && !(doc.doc_date ? doc.doc_date >= f.dateFrom : (doc.doc_year ?? -1) >= yearOf(f.dateFrom))) return false;
      if (f.dateTo && !(doc.doc_date ? doc.doc_date <= f.dateTo : doc.doc_year !== null && doc.doc_year <= yearOf(f.dateTo)))
        return false;
      return true;
    }

    const customers = () => [...new Set(docMeta.map((d) => d.customer).filter((c): c is string => !!c))];

    it("客先（一部でも可）・期間・部署の絞り込みが、条件に合う文書だけを返す（全部署の権限を持つ人で確認）", async () => {
      const years = [...new Set(docMeta.map((d) => d.doc_year).filter((y): y is number => y !== null))].sort();
      const cases: F[] = [
        {},
        ...customers().flatMap((c) => [{ customer: c }, { customer: c.slice(0, 2) }]),
        { dateFrom: `${years[years.length - 1]}-01-01` },
        { dateTo: `${years[0]}-12-31` },
        { dateFrom: `${years[0]}-01-01`, dateTo: `${years[0]}-12-31` },
        { dateFrom: "2099-01-01" },
        ...departments.map((d) => ({ departmentId: d.id })),
      ];
      for (const f of cases) {
        for (const probe of probes) {
          const got = await webSearch(allUserId, probe, f);
          const expected = new Set(
            docMeta
              .filter((d) => matches(d, f) && (f.departmentId === undefined || access.get(d.id)?.has(f.departmentId)))
              .map((d) => d.id),
          );
          // 条件に合わない文書が混ざらない
          for (const id of got) expect(expected.has(id), `${JSON.stringify(f)} に合わない文書が返った`).toBe(true);
          // 条件に合う文書を取りこぼさない（その文書自身の内容で検索したとき）
          if (expected.has(probe.documentId)) expect(got.has(probe.documentId), `${JSON.stringify(f)} × ${probe.title}`).toBe(true);
        }
      }
    }, 180_000);

    it("どの絞り込み条件を組み合わせても、権限のない文書は表示されない（6部署）", async () => {
      const years = docMeta.map((d) => d.doc_year).filter((y): y is number => y !== null);
      const filters: F[] = [
        {},
        { customer: customers()[0] },
        { dateFrom: `${Math.min(...years)}-01-01` },
        ...departments.map((d) => ({ departmentId: d.id })), // 自分の部署でない部署の指定も含む
      ];
      const violations: string[] = [];
      for (const user of testUsers.filter((u) => u.departmentId !== null)) {
        for (const f of filters) {
          for (const probe of probes) {
            for (const id of await webSearch(user.id, probe, f)) {
              if (!access.get(id)?.has(user.departmentId!)) violations.push(`${user.departmentName} × ${JSON.stringify(f)}`);
            }
          }
        }
      }
      expect(violations).toEqual([]);
    }, 240_000);

    it("他部署を絞り込み条件に指定しても、その部署の文書は返らない", async () => {
      for (const user of testUsers.filter((u) => u.departmentId !== null)) {
        for (const probe of probes) {
          const others = [...(access.get(probe.documentId) ?? [])].filter((d) => d !== user.departmentId);
          for (const dep of others) {
            expect([...(await webSearch(user.id, probe, { departmentId: dep }))], `${user.departmentName} が部署${dep}を指定`).toEqual(
              [],
            );
          }
        }
      }
    }, 240_000);
  });

  describe("AC-05: 該当情報が無い質問では、創作せず「見つからない」と返す", () => {
    it("無関係な質問は根拠が空になり、Claude を呼ばずに定型の「見つかりません」になる", async () => {
      if (!process.env.OPENAI_API_KEY) return; // Embedding が作れない環境ではスキップ
      const { retrieveChunks } = await import("../lib/rag/retrieve");
      const { generateAnswer, NOT_FOUND_MESSAGE } = await import("../lib/rag/answer");
      const user = testUsers.find((u) => u.departmentName === "戦略")!;

      for (const question of ["火星探査機の姿勢制御アルゴリズムの設計基準は？", "今夜のカレーの隠し味は何がいい？"]) {
        const chunks = await retrieveChunks(db, { userId: user.id, question });
        expect(chunks, question).toEqual([]);
        // Claude のクライアントを渡していない＝呼ばれたら API キーが必要になる。根拠が空なら呼ばれず、そのまま返る
        const result = await generateAnswer(question, chunks);
        expect(result).toEqual({ status: "not_found", answer: NOT_FOUND_MESSAGE, sources: [] });
      }
    }, 60_000);
  });
});
