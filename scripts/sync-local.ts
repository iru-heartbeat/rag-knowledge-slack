// ローカルフォルダの文書を、本物の DB に取り込む手動実行用スクリプト（動作確認・初回投入用）。
// 実行: npx tsx --conditions=react-server --env-file=.env.local scripts/sync-local.ts [フォルダ]
//   --conditions=react-server は、サーバー専用の印（server-only）を Next.js の外で読めるようにするため
import { resolve } from "node:path";
import { getAdminClient } from "../src/lib/supabase";
import { createLocalFolderSource } from "../src/lib/sources/local";
import { runSync } from "../src/lib/sync/run";

async function main() {
  const dir = resolve(process.argv[2] ?? "テスト用PDF_元ファイル");
  console.log(`取り込み元: ${dir}`);

  const result = await runSync(getAdminClient(), createLocalFolderSource(dir), {
    cursorKey: "sync:local",
  });
  console.log("結果:", result);
}

main().catch((e) => {
  console.error("同期に失敗しました:", e instanceof Error ? e.message : e);
  process.exit(1);
});
