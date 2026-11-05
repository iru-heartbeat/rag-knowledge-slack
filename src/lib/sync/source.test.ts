import { describe, expect, it } from "vitest";
import { resolveSyncConfig } from "./source";

describe("resolveSyncConfig", () => {
  it("未指定なら SharePoint（本番の既定）", () => {
    expect(resolveSyncConfig({})).toEqual({ kind: "sharepoint", cursorKey: "sync:sharepoint" });
  });

  it("local ならフォルダの指定が必須。カーソルは SharePoint と別のキーにする", () => {
    expect(resolveSyncConfig({ SYNC_SOURCE: "local", LOCAL_SOURCE_DIR: "C:/docs" })).toEqual({
      kind: "local",
      dir: "C:/docs",
      cursorKey: "sync:local",
    });
    expect(() => resolveSyncConfig({ SYNC_SOURCE: "local" })).toThrow(/LOCAL_SOURCE_DIR/);
  });

  it("空文字は未指定と同じ扱い", () => {
    expect(resolveSyncConfig({ SYNC_SOURCE: "" }).kind).toBe("sharepoint");
  });

  it("知らない値は、黙って別の入手元にせずエラー", () => {
    expect(() => resolveSyncConfig({ SYNC_SOURCE: "dropbox" })).toThrow(/SYNC_SOURCE/);
  });
});
