import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // テストファイルを順番に実行する。受入テスト（src/acceptance）は同じ本物の DB を使い、一時的な文書やユーザーを作る。
    // 並列だと、他のファイルが作った一時データが検索結果に混ざって、権限の判定が崩れて見える
    fileParallelism: false,
  },
  resolve: {
    alias: {
      // "server-only" は、ブラウザ向けコードから読み込まれるとエラーにする本番用の保護。
      // Node で動くテストでは「ブラウザから読まれた」わけではないので、何もしない空のモジュールに差し替える
      "server-only": fileURLToPath(new URL("./src/test/server-only-stub.ts", import.meta.url)),
    },
  },
});
