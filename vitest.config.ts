import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // "server-only" は、ブラウザ向けコードから読み込まれるとエラーにする本番用の保護。
      // Node で動くテストでは「ブラウザから読まれた」わけではないので、何もしない空のモジュールに差し替える
      "server-only": fileURLToPath(new URL("./src/test/server-only-stub.ts", import.meta.url)),
    },
  },
});
