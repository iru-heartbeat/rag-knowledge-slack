import { describe, expect, it, vi } from "vitest";
import { PermanentSourceError } from "../sources/types";
import { createGraphClient, graphAsSource, toSourceItem, type GraphDeltaItem } from "./client";

const ENV = { tenantId: "t", clientId: "c", clientSecret: "s", driveId: "drive1" };

type Call = { url: string; init?: RequestInit };

/** fetch の偽物。URL の部分一致で応答を返し、呼び出し履歴を残す */
function fakeFetch(routes: Array<[string, () => Response]>) {
  const calls: Call[] = [];
  const fn = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, init });
    const route = routes.find(([part]) => u.includes(part));
    if (!route) throw new Error(`想定外のURL: ${u}`);
    return route[1]();
  });
  return { fetch: fn as unknown as typeof fetch, calls };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const token = () => json({ access_token: "tok", expires_in: 3600 });

describe("toSourceItem", () => {
  const base: GraphDeltaItem = {
    id: "i1",
    name: "提案書.pdf",
    webUrl: "https://sp.example/提案書.pdf",
    file: { mimeType: "application/pdf" },
    parentReference: { path: "/drives/drive1/root:/営業/2024" },
  };

  it("PDF は fileType=pdf、Word(.docx) は docx", () => {
    expect(toSourceItem(base)).toMatchObject({ kind: "file", fileType: "pdf", sharepointId: "i1", title: "提案書.pdf" });
    expect(toSourceItem({ ...base, name: "報告.DOCX" })).toMatchObject({ kind: "file", fileType: "docx" });
  });

  it("ファイルサイズを持つ（大きすぎるファイルを取りに行く前に除くため）", () => {
    expect(toSourceItem({ ...base, size: 1234 })).toMatchObject({ size: 1234 });
    expect(toSourceItem(base)).toMatchObject({ size: null });
  });

  it("フォルダパス(親の位置)を持つ", () => {
    expect(toSourceItem(base)).toMatchObject({ folderPath: "/営業/2024" });
  });

  it("削除された項目は deleted(この時点では name が無いことがある)", () => {
    expect(toSourceItem({ id: "i2", deleted: {} })).toEqual({ kind: "deleted", sharepointId: "i2" });
  });

  it("フォルダ・PowerPoint・旧 .doc などの対象外は null", () => {
    expect(toSourceItem({ id: "f", name: "営業", folder: { childCount: 3 } })).toBeNull();
    expect(toSourceItem({ ...base, name: "資料.pptx", file: {} })).toBeNull();
    expect(toSourceItem({ ...base, name: "古い.doc", file: {} })).toBeNull();
  });
});

describe("createGraphClient.fetchDeltaPage", () => {
  it("初回は root/delta を呼び、アクセストークンを付ける。対象外の項目は除く", async () => {
    const { fetch, calls } = fakeFetch([
      ["login.microsoftonline.com/t/oauth2/v2.0/token", token],
      [
        "/drives/drive1/root/delta",
        () =>
          json({
            value: [
              { id: "a", name: "a.pdf", webUrl: "u", file: {} },
              { id: "b", name: "b.png", webUrl: "u", file: {} },
              { id: "c", deleted: {} },
            ],
            "@odata.nextLink": "https://graph.microsoft.com/v1.0/next?token=2",
          }),
      ],
    ]);
    const page = await createGraphClient(ENV, fetch).fetchDeltaPage(null);

    expect(page.items.map((i) => i.sharepointId)).toEqual(["a", "c"]);
    expect(page.nextLink).toBe("https://graph.microsoft.com/v1.0/next?token=2");
    expect(page.deltaLink).toBeNull();
    const graphCall = calls.find((c) => c.url.includes("/root/delta"))!;
    expect((graphCall.init?.headers as Record<string, string>).Authorization).toBe("Bearer tok");
  });

  it("リンクを渡すとそのURLを続きとして呼ぶ。最後のページは deltaLink を返す", async () => {
    const { fetch, calls } = fakeFetch([
      ["/oauth2/v2.0/token", token],
      ["/v1.0/next", () => json({ value: [], "@odata.deltaLink": "https://graph.microsoft.com/v1.0/d?token=9" })],
    ]);
    const page = await createGraphClient(ENV, fetch).fetchDeltaPage("https://graph.microsoft.com/v1.0/next?token=2");

    expect(page.deltaLink).toBe("https://graph.microsoft.com/v1.0/d?token=9");
    expect(page.nextLink).toBeNull();
    expect(calls.some((c) => c.url === "https://graph.microsoft.com/v1.0/next?token=2")).toBe(true);
  });

  it("Graph 以外のホストのリンクは呼ばない（保存済みリンクの改ざんでトークンが漏れないように）", async () => {
    const { fetch, calls } = fakeFetch([["/oauth2/v2.0/token", token]]);
    await expect(createGraphClient(ENV, fetch).fetchDeltaPage("https://evil.example/x")).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it("トークンは使い回す（2回呼んでも取得は1回）", async () => {
    const { fetch, calls } = fakeFetch([
      ["/oauth2/v2.0/token", token],
      ["/root/delta", () => json({ value: [], "@odata.deltaLink": "d" })],
    ]);
    const c = createGraphClient(ENV, fetch);
    await c.fetchDeltaPage(null);
    await c.fetchDeltaPage(null);
    expect(calls.filter((x) => x.url.includes("/oauth2/")).length).toBe(1);
  });

  it("429 のときは Retry-After の秒数だけ待って再試行する", async () => {
    let n = 0;
    const { fetch } = fakeFetch([
      ["/oauth2/v2.0/token", token],
      ["/root/delta", () => (n++ === 0 ? json({}, 429, { "retry-after": "0" }) : json({ value: [], "@odata.deltaLink": "d" }))],
    ]);
    const page = await createGraphClient(ENV, fetch, { sleep: async () => {} }).fetchDeltaPage(null);
    expect(page.deltaLink).toBe("d");
    expect(n).toBe(2);
  });

  it("再試行しても失敗し続けたら、ステータス付きのエラー", async () => {
    const { fetch } = fakeFetch([
      ["/oauth2/v2.0/token", token],
      ["/root/delta", () => json({}, 503)],
    ]);
    await expect(
      createGraphClient(ENV, fetch, { sleep: async () => {} }).fetchDeltaPage(null),
    ).rejects.toThrow(/503/);
  });

  it("認証の失敗(401/403)は再試行せず、すぐエラー", async () => {
    let n = 0;
    const { fetch } = fakeFetch([
      ["/oauth2/v2.0/token", token],
      ["/root/delta", () => (n++, json({}, 403))],
    ]);
    await expect(createGraphClient(ENV, fetch, { sleep: async () => {} }).fetchDeltaPage(null)).rejects.toThrow(/403/);
    expect(n).toBe(1);
  });
});

describe("createGraphClient.downloadFile の永続的な失敗", () => {
  it("404(消えた)・410(削除済み)は、やり直しても直らないので PermanentSourceError にする", async () => {
    for (const status of [404, 410]) {
      const { fetch } = fakeFetch([
        ["/oauth2/v2.0/token", token],
        ["/items/", () => json({}, status)],
      ]);
      await expect(createGraphClient(ENV, fetch, { sleep: async () => {} }).downloadFile("i1")).rejects.toBeInstanceOf(
        PermanentSourceError,
      );
    }
  });

  it("403 や 5xx は、権限や一時障害の可能性があるため、永続失敗にはしない", async () => {
    const { fetch } = fakeFetch([
      ["/oauth2/v2.0/token", token],
      ["/items/", () => json({}, 403)],
    ]);
    const err = await createGraphClient(ENV, fetch, { sleep: async () => {} }).downloadFile("i1").catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(PermanentSourceError);
  });
});

describe("createGraphClient.downloadFile", () => {
  it("items/{id}/content を取得して Buffer で返す", async () => {
    const { fetch, calls } = fakeFetch([
      ["/oauth2/v2.0/token", token],
      ["/drives/drive1/items/i1/content", () => new Response(new Uint8Array([1, 2, 3]))],
    ]);
    const buf = await createGraphClient(ENV, fetch).downloadFile("i1");
    expect([...buf]).toEqual([1, 2, 3]);
    expect(calls.some((c) => c.url.includes("/items/i1/content"))).toBe(true);
  });

  it("IDは URL エンコードする（パスを書き換えられないように）", async () => {
    const { fetch, calls } = fakeFetch([
      ["/oauth2/v2.0/token", token],
      ["/items/", () => new Response(new Uint8Array([1]))],
    ]);
    await createGraphClient(ENV, fetch).downloadFile("a/b?c");
    expect(calls.at(-1)!.url).toContain("/items/a%2Fb%3Fc/content");
  });
});

describe("graphAsSource", () => {
  it("delta の nextLink/deltaLink を、共通の窓口の nextCursor/finalCursor に対応させる", async () => {
    const { fetch } = fakeFetch([
      ["/oauth2/v2.0/token", token],
      ["/root/delta", () => json({ value: [{ id: "a", name: "a.pdf", file: {} }], "@odata.nextLink": "https://graph.microsoft.com/v1.0/n" })],
    ]);
    const page = await graphAsSource(createGraphClient(ENV, fetch)).fetchChanges(null);
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBe("https://graph.microsoft.com/v1.0/n");
    expect(page.finalCursor).toBeNull();
  });
});
