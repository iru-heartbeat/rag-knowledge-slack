import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { NoTextError } from "../ingest/parse-pdf";
import { ParseError, type IngestResult } from "../ingest/pipeline";
import { PermanentSourceError, type ChangePage, type DocumentSource, type SourceItem } from "../sources/types";
import { runSync } from "./run";

type Row = Record<string, unknown>;

/** Supabase の偽物。runSync が使う書き込みを記録し、sync_state だけは状態を持つ */
function fakeDb(init: { cursor?: string; runningRuns?: number } = {}) {
  const state = new Map<string, string>(init.cursor ? [["sync:test", init.cursor]] : []);
  const log = {
    runUpdates: [] as Row[],
    errors: [] as Row[],
    deletes: [] as string[],
    cursorWrites: [] as string[],
  };
  const from = (table: string) => {
    const b: Record<string, unknown> = {};
    let op: "select" | "insert" | "update" | "upsert" = "select";
    let payload: Row = {};
    let eqVal: unknown;
    const finish = () => {
      // 実行中の同期があるとき、2つ目の run の作成は「1つしか running にできない」制約(23505)で失敗する
      if (table === "ingestion_runs" && op === "insert") {
        if ((init.runningRuns ?? 0) > 0) return { data: null, error: { code: "23505", message: "duplicate key" } };
        return { data: { id: 1 }, error: null };
      }
      if (table === "ingestion_runs" && op === "update") log.runUpdates.push(payload);
      if (table === "ingestion_errors" && op === "insert") log.errors.push(payload);
      if (table === "documents" && op === "update") log.deletes.push(eqVal as string);
      if (table === "sync_state" && op === "select") {
        const v = state.get(eqVal as string);
        return { data: v === undefined ? null : { value: v }, error: null };
      }
      if (table === "sync_state" && op === "upsert") {
        state.set(payload.key as string, payload.value as string);
        log.cursorWrites.push(payload.value as string);
      }
      return { data: null, error: null };
    };
    Object.assign(b, {
      select: () => b,
      insert: (p: Row) => ((op = "insert"), (payload = p), b),
      update: (p: Row) => ((op = "update"), (payload = p), b),
      upsert: (p: Row) => ((op = "upsert"), (payload = p), b),
      eq: (_c: string, v: unknown) => ((eqVal = v), b),
      gt: () => b,
      lt: () => b,
      limit: () => b,
      single: () => Promise.resolve(finish()),
      maybeSingle: () => Promise.resolve(finish()),
      then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(finish()).then(res, rej),
    });
    return b;
  };
  return { db: { from } as unknown as SupabaseClient, state, log };
}

const file = (id: string, size: number | null = null): SourceItem => ({
  kind: "file",
  sharepointId: id,
  title: `${id}.pdf`,
  url: `u/${id}`,
  fileType: "pdf",
  folderPath: "",
  lastModified: null,
  size,
});
const gone = (id: string): SourceItem => ({ kind: "deleted", sharepointId: id });

/** pages を順に返す入手元。cursor は "p1","p2"…（null は先頭ページ） */
function fakeSource(pages: Array<Partial<ChangePage> & { items: SourceItem[] }>, throwAt?: number) {
  const seen: Array<string | null> = [];
  const source: DocumentSource = {
    fetchChanges: vi.fn(async (cursor) => {
      seen.push(cursor);
      const i = cursor === null ? 0 : Number(cursor.slice(1));
      if (i === throwAt) throw new Error("入手元が落ちています");
      const p = pages[i];
      const last = i === pages.length - 1;
      return { nextCursor: last ? null : `p${i + 1}`, finalCursor: last ? "final" : null, ...p };
    }),
    download: vi.fn(async () => Buffer.from("x")),
  };
  return { source, seen };
}

const saved: IngestResult = { status: "saved", documentId: "d", unassigned: false, unmatchedDepartments: [] };
const base = { cursorKey: "sync:test" };

describe("runSync", () => {
  it("全ファイルを取り込み、件数を記録し、最後のカーソルを保存する", async () => {
    const { db, state, log } = fakeDb();
    const { source } = fakeSource([{ items: [file("a"), file("b")] }]);
    const ingest = vi.fn(async () => saved);

    const r = await runSync(db, source, { ...base, ingest });

    expect(ingest).toHaveBeenCalledTimes(2);
    expect(r).toMatchObject({ status: "done", total: 2, succeeded: 2, failed: 0 });
    expect(state.get("sync:test")).toBe("final");
    expect(log.runUpdates.at(-1)).toMatchObject({ status: "done", total: 2, succeeded: 2, failed: 0 });
  });

  it("1件が失敗しても他は続行し、失敗は ingestion_errors に記録、状態は partial", async () => {
    const { db, log } = fakeDb();
    const { source } = fakeSource([{ items: [file("a"), file("b"), file("c")] }]);
    const ingest = vi.fn(async (_db: unknown, f: { sharepointId: string }) => {
      if (f.sharepointId === "b") throw new Error("壊れたPDF");
      return saved;
    });

    const r = await runSync(db, source, { ...base, ingest: ingest as never });

    expect(r).toMatchObject({ status: "partial", total: 3, succeeded: 2, failed: 1 });
    expect(log.errors).toEqual([
      expect.objectContaining({ run_id: 1, sharepoint_id: "b", title: "b.pdf", error_message: "壊れたPDF" }),
    ]);
  });

  it("変更なし(skipped)も成功として数える", async () => {
    const { db } = fakeDb();
    const { source } = fakeSource([{ items: [file("a")] }]);
    const r = await runSync(db, source, { ...base, ingest: async () => ({ status: "skipped" }) });
    expect(r).toMatchObject({ status: "done", succeeded: 1, skipped: 1 });
  });

  it("部署が判定できなかった文書は、失敗として記録する（保存はされている）", async () => {
    const { db, log } = fakeDb();
    const { source } = fakeSource([{ items: [file("a")] }]);
    const r = await runSync(db, source, {
      ...base,
      ingest: async () => ({ ...saved, unassigned: true, unmatchedDepartments: ["総務"] }),
    });
    expect(r).toMatchObject({ status: "partial", failed: 1 });
    expect(log.errors[0].error_message).toContain("部署を判定できません");
    expect(log.errors[0].error_message).toContain("総務");
  });

  it("削除は documents を status=deleted にする（検索対象から外れる）", async () => {
    const { db, log } = fakeDb();
    const { source } = fakeSource([{ items: [gone("x")] }]);
    const ingest = vi.fn();
    const r = await runSync(db, source, { ...base, ingest });
    expect(log.deletes).toEqual(["x"]);
    expect(ingest).not.toHaveBeenCalled();
    expect(r).toMatchObject({ status: "done", deleted: 1, succeeded: 1 });
  });

  it("保存済みのカーソルから再開し、複数ページを最後まで辿る。途中のカーソルも保存する", async () => {
    const { db, state, log } = fakeDb({ cursor: "p1" });
    const { source, seen } = fakeSource([{ items: [file("a")] }, { items: [file("b")] }, { items: [file("c")] }]);
    await runSync(db, source, { ...base, ingest: async () => saved });
    expect(seen).toEqual(["p1", "p2"]);
    expect(log.cursorWrites).toEqual(["p2", "final"]);
    expect(state.get("sync:test")).toBe("final");
  });

  it("失敗があったら、そのページの位置から次回やり直せるようカーソルを進めない", async () => {
    const { db, state } = fakeDb();
    const { source } = fakeSource([{ items: [file("a")] }, { items: [file("b")] }, { items: [file("c")] }]);
    const ingest = async (_db: unknown, f: { sharepointId: string }) => {
      if (f.sharepointId === "b") throw new Error("一時的な障害");
      return saved;
    };
    const r = await runSync(db, source, { ...base, ingest: ingest as never });
    expect(r.status).toBe("partial");
    expect(state.get("sync:test")).toBe("p1"); // b のあるページの先頭
  });

  it("スキャンのみのPDF(OCR対象外)は、やり直しても直らないので、カーソルは進める", async () => {
    const { db, state, log } = fakeDb();
    const { source } = fakeSource([{ items: [file("a")] }]);
    const r = await runSync(db, source, {
      ...base,
      ingest: async () => {
        throw new NoTextError();
      },
    });
    expect(r).toMatchObject({ status: "partial", failed: 1 });
    expect(log.errors).toHaveLength(1);
    expect(state.get("sync:test")).toBe("final");
  });

  it("壊れたファイル(読み取り不能)は、やり直しても直らないので、カーソルは進める。後ろのファイルが止まらない", async () => {
    const { db, state, log } = fakeDb();
    const { source } = fakeSource([{ items: [file("a")] }, { items: [file("b")] }]);
    const r = await runSync(db, source, {
      ...base,
      ingest: async (_db, f) => {
        if (f.sharepointId === "a") throw new ParseError("a.pdf", new Error("Invalid PDF structure"));
        return saved;
      },
    });
    expect(r).toMatchObject({ status: "partial", failed: 1, succeeded: 1 });
    expect(log.errors).toHaveLength(1);
    expect(state.get("sync:test")).toBe("final"); // 壊れた a で止まらず、最後まで進む
  });

  it("入手元で消えていた(404/410)ファイルは、やり直しても直らないので、カーソルは進める", async () => {
    const { db, state, log } = fakeDb();
    const { source } = fakeSource([{ items: [file("a")] }, { items: [file("b")] }]);
    (source.download as ReturnType<typeof vi.fn>).mockImplementation(async (id: string) => {
      if (id === "a") throw new PermanentSourceError("見つかりません");
      return Buffer.from("x");
    });
    const r = await runSync(db, source, { ...base, ingest: async () => saved });
    expect(r).toMatchObject({ status: "partial", failed: 1, succeeded: 1 });
    expect(log.errors).toHaveLength(1);
    expect(state.get("sync:test")).toBe("final");
  });

  it("上限を超えるサイズのファイルは、ダウンロードせずに失敗として記録し、カーソルは進める", async () => {
    const { db, state, log } = fakeDb();
    const { source } = fakeSource([{ items: [file("big", 999_999_999), file("ok", 1000)] }]);
    const ingest = vi.fn(async () => saved);
    const r = await runSync(db, source, { ...base, ingest, maxFileBytes: 10_000_000 });
    expect(source.download).toHaveBeenCalledTimes(1); // big は取りに行かない
    expect(ingest).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ status: "partial", failed: 1, succeeded: 1 });
    expect(log.errors[0]).toMatchObject({ sharepoint_id: "big" });
    expect(String(log.errors[0].error_message)).toContain("大き");
    expect(state.get("sync:test")).toBe("final");
  });

  it("ダウンロードしてみたら上限を超えていた場合も、取り込まずに失敗として記録する", async () => {
    const { db } = fakeDb();
    const { source } = fakeSource([{ items: [file("a")] }]);
    (source.download as ReturnType<typeof vi.fn>).mockResolvedValue(Buffer.alloc(100));
    const ingest = vi.fn(async () => saved);
    const r = await runSync(db, source, { ...base, ingest, maxFileBytes: 50 });
    expect(ingest).not.toHaveBeenCalled();
    expect(r).toMatchObject({ failed: 1 });
  });

  it("時間切れなら、途中のページのカーソルは進めずに止まる（次回その続きから）", async () => {
    const { db, state } = fakeDb();
    const { source } = fakeSource([{ items: [file("a")] }, { items: [file("b"), file("c")] }]);
    let clock = 0;
    const ingest = vi.fn(async () => {
      clock += 10;
      return saved;
    });
    const r = await runSync(db, source, { ...base, ingest, maxDurationMs: 15, now: () => clock });
    // a(clock=10)は処理、b(clock=20)で処理後に超過、c は未処理
    expect(r.status).toBe("partial");
    expect(r.stoppedEarly).toBe(true);
    expect(ingest).toHaveBeenCalledTimes(2);
    expect(state.get("sync:test")).toBe("p1"); // 1ページ目まで完了。2ページ目は途中なので進めない
  });

  it("入手元の取得自体が失敗したら、状態は error、カーソルは変えない", async () => {
    const { db, state, log } = fakeDb({ cursor: "p0" });
    const { source } = fakeSource([{ items: [] }], 0);
    const r = await runSync(db, source, { ...base, ingest: vi.fn() });
    expect(r.status).toBe("error");
    expect(state.get("sync:test")).toBe("p0");
    expect(log.errors[0].error_message).toContain("入手元が落ちています");
  });

  it("すでに実行中の同期があれば、二重に動かさない", async () => {
    const { db } = fakeDb({ runningRuns: 1 });
    const { source } = fakeSource([{ items: [] }]);
    await expect(runSync(db, source, { ...base, ingest: vi.fn() })).rejects.toThrow(/実行中/);
  });
});
