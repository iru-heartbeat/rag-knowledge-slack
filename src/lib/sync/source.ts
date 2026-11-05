import "server-only";
import { getGraphClient, graphAsSource } from "../graph/client";
import { createLocalFolderSource } from "../sources/local";
import type { DocumentSource } from "../sources/types";

export type SyncConfig =
  | { kind: "sharepoint"; cursorKey: string }
  | { kind: "local"; dir: string; cursorKey: string };

/**
 * 環境変数から、どこから文書を取り込むかを決める。
 *  SYNC_SOURCE=sharepoint（既定） / local（SharePoint を用意できない環境の代用。LOCAL_SOURCE_DIR が必要）
 * カーソル（どこまで同期したか）は入手元ごとに別のキーで保存する。混ざると、別の入手元の続きから始めてしまう。
 */
export function resolveSyncConfig(env: Record<string, string | undefined>): SyncConfig {
  const kind = env.SYNC_SOURCE || "sharepoint";
  if (kind === "sharepoint") return { kind, cursorKey: "sync:sharepoint" };
  if (kind === "local") {
    if (!env.LOCAL_SOURCE_DIR) throw new Error("SYNC_SOURCE=local のときは LOCAL_SOURCE_DIR（取り込むフォルダ）が必要です");
    return { kind, dir: env.LOCAL_SOURCE_DIR, cursorKey: "sync:local" };
  }
  throw new Error(`SYNC_SOURCE の値が不正です: ${kind}（sharepoint か local）`);
}

export function createSyncSource(config: SyncConfig): DocumentSource {
  return config.kind === "local" ? createLocalFolderSource(config.dir) : graphAsSource(getGraphClient());
}
