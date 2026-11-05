import "server-only"; // Azure のクライアントシークレットを扱うため、ブラウザ向けのコードから読み込めないようにする
import { requireEnv } from "../config";
import { PermanentSourceError, type DocumentSource, type SourceItem } from "../sources/types";

export type { SourceItem };

// ===== 型 =====

/** Graph の delta API が返す項目のうち、使う部分だけ */
export type GraphDeltaItem = {
  id: string;
  name?: string;
  webUrl?: string;
  size?: number;
  lastModifiedDateTime?: string;
  file?: Record<string, unknown>;
  folder?: Record<string, unknown>;
  deleted?: Record<string, unknown>;
  parentReference?: { path?: string };
};

export type DeltaPage = {
  items: SourceItem[];
  /** まだ続きがあるときの次ページのリンク */
  nextLink: string | null;
  /** 最後のページでだけ返る。次回の同期はここから始めると、変更分だけ取れる */
  deltaLink: string | null;
};

export type GraphEnv = { tenantId: string; clientId: string; clientSecret: string; driveId: string };

export type GraphClient = {
  /** 差分を1ページ分取得する。link が null なら最初から（全件）。 */
  fetchDeltaPage(link: string | null): Promise<DeltaPage>;
  downloadFile(itemId: string): Promise<Buffer>;
};

// ===== 項目の整形 =====

/**
 * delta の1項目を取り込み用に整える。対象外（フォルダ、PDF/docx 以外）は null。
 * 削除された項目は、ファイル名などが付かないことがあるため id だけで返す。
 * （フォルダや対象外ファイルの削除も届くが、DB に無い id なので呼び出し側では何も起きない）
 */
export function toSourceItem(item: GraphDeltaItem): SourceItem | null {
  if (item.deleted) return { kind: "deleted", sharepointId: item.id };
  if (!item.file || !item.name) return null;

  const lower = item.name.toLowerCase();
  const fileType = lower.endsWith(".pdf") ? "pdf" : lower.endsWith(".docx") ? "docx" : null;
  if (!fileType) return null;

  return {
    kind: "file",
    sharepointId: item.id,
    title: item.name,
    url: item.webUrl ?? "",
    fileType,
    folderPath: folderPathOf(item.parentReference?.path),
    lastModified: item.lastModifiedDateTime ?? null,
    size: item.size ?? null,
  };
}

/** "/drives/{id}/root:/営業/2024" → "/営業/2024"（ルート直下なら ""） */
function folderPathOf(path: string | undefined): string {
  const i = path?.indexOf("root:") ?? -1;
  if (!path || i < 0) return "";
  const rest = path.slice(i + "root:".length);
  try {
    return decodeURIComponent(rest);
  } catch {
    return rest;
  }
}

// ===== クライアント =====

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
// 一時的な障害なので、待てば成功する可能性があるもの。401/403/404 などは待っても直らないので再試行しない
const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 4;
const MAX_WAIT_MS = 60_000;

/** Graph が失敗を返した。状態コードで、待てば直るものか、ファイルが無いのかを見分ける */
class GraphHttpError extends Error {
  constructor(readonly status: number) {
    super(`SharePoint(Graph) の呼び出しに失敗しました（HTTP ${status}）`);
    this.name = "GraphHttpError";
  }
}

type Options = { sleep?: (ms: number) => Promise<void> };

export function createGraphClient(
  env: GraphEnv,
  fetchImpl: typeof fetch = fetch,
  { sleep = (ms) => new Promise<void>((r) => setTimeout(r, ms)) }: Options = {},
): GraphClient {
  let cached: { token: string; expiresAt: number } | undefined;

  async function getToken(): Promise<string> {
    // 期限の60秒前に取り直す（ぎりぎりで切れて失敗するのを避ける）
    if (cached && Date.now() < cached.expiresAt - 60_000) return cached.token;

    const res = await fetchImpl(
      `https://login.microsoftonline.com/${encodeURIComponent(env.tenantId)}/oauth2/v2.0/token`,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: env.clientId,
          client_secret: env.clientSecret,
          scope: "https://graph.microsoft.com/.default",
          grant_type: "client_credentials",
        }),
      },
    );
    // エラー本文にシークレットが含まれる可能性は低いが、ログに残る例外には本文を載せない
    if (!res.ok) throw new Error(`Microsoft のアクセストークン取得に失敗しました（HTTP ${res.status}）`);
    const body = (await res.json()) as { access_token: string; expires_in: number };
    cached = { token: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
    return cached.token;
  }

  /** 認証つきで Graph を呼ぶ。一時的な失敗は待ってから再試行する */
  async function graphFetch(url: string): Promise<Response> {
    for (let attempt = 1; ; attempt++) {
      const token = await getToken();
      const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` } });
      if (res.ok) return res;

      if (!RETRYABLE.has(res.status) || attempt >= MAX_ATTEMPTS) {
        throw new GraphHttpError(res.status);
      }
      // サーバーが待ち時間を指定していればそれに従い、無ければ 1秒→2秒→4秒 と伸ばす
      const retryAfter = Number(res.headers.get("retry-after"));
      const wait = Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter * 1000 : 1000 * 2 ** (attempt - 1);
      await sleep(Math.min(wait, MAX_WAIT_MS));
    }
  }

  return {
    async fetchDeltaPage(link) {
      // 保存済みのリンクを呼ぶ前に、行き先が Graph か確かめる。
      // DB の値が書き換えられても、アクセストークンを別のサーバーに送ってしまわないため
      if (link !== null && !link.startsWith(`${GRAPH_BASE}/`)) {
        throw new Error("delta リンクが Microsoft Graph のものではありません");
      }
      const url = link ?? `${GRAPH_BASE}/drives/${encodeURIComponent(env.driveId)}/root/delta`;
      const body = (await (await graphFetch(url)).json()) as {
        value?: GraphDeltaItem[];
        "@odata.nextLink"?: string;
        "@odata.deltaLink"?: string;
      };
      return {
        items: (body.value ?? []).map(toSourceItem).filter((i): i is SourceItem => i !== null),
        nextLink: body["@odata.nextLink"] ?? null,
        deltaLink: body["@odata.deltaLink"] ?? null,
      };
    },

    async downloadFile(itemId) {
      // /content は一時的なダウンロードURLへ転送される。fetch が自動で追従する
      const url = `${GRAPH_BASE}/drives/${encodeURIComponent(env.driveId)}/items/${encodeURIComponent(itemId)}/content`;
      try {
        return Buffer.from(await (await graphFetch(url)).arrayBuffer());
      } catch (e) {
        // 404(消えた)・410(削除済み)は、何度やっても取れない。403 は権限の設定ミスなど全体の問題かもしれないので、ここでは分けない
        if (e instanceof GraphHttpError && (e.status === 404 || e.status === 410)) {
          throw new PermanentSourceError(e.message);
        }
        throw e;
      }
    },
  };
}

let defaultClient: GraphClient | undefined;

/** 環境変数から作る本番用クライアント（トークンの使い回しのため1つだけ作る） */
export function getGraphClient(): GraphClient {
  defaultClient ??= createGraphClient({
    tenantId: requireEnv("AZURE_TENANT_ID"),
    clientId: requireEnv("AZURE_CLIENT_ID"),
    clientSecret: requireEnv("AZURE_CLIENT_SECRET"),
    driveId: requireEnv("SHAREPOINT_DRIVE_ID"),
  });
  return defaultClient;
}

/** 取り込み側の共通の窓口（DocumentSource）として使えるようにする。delta のリンクを「続きの目印」として渡す */
export function graphAsSource(client: GraphClient): DocumentSource {
  return {
    async fetchChanges(cursor) {
      const page = await client.fetchDeltaPage(cursor);
      return { items: page.items, nextCursor: page.nextLink, finalCursor: page.deltaLink };
    },
    download: (id) => client.downloadFile(id),
  };
}
