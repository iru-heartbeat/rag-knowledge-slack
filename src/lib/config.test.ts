import { afterEach, describe, expect, it, vi } from "vitest";

// config は読み込み時に環境変数を読むので、テストごとにモジュールを読み直す
async function loadConfig() {
  vi.resetModules();
  return (await import("./config")).config;
}

afterEach(() => vi.unstubAllEnvs());

describe("config", () => {
  it("環境変数が未設定なら既定のモデル名", async () => {
    vi.stubEnv("CLAUDE_MODEL", undefined as unknown as string);
    vi.stubEnv("EMBEDDING_MODEL", undefined as unknown as string);
    const c = await loadConfig();
    expect(c.claudeModel).toBe("claude-sonnet-5-5");
    expect(c.embeddingModel).toBe("text-embedding-3-small");
  });

  it("環境変数が空文字（`CLAUDE_MODEL=` だけ書いた状態）でも既定値になる（レビュー指摘）", async () => {
    vi.stubEnv("CLAUDE_MODEL", "");
    vi.stubEnv("EMBEDDING_MODEL", "");
    const c = await loadConfig();
    expect(c.claudeModel).toBe("claude-sonnet-5-5");
    expect(c.embeddingModel).toBe("text-embedding-3-small");
  });

  it("値が設定されていればそれを使う", async () => {
    vi.stubEnv("CLAUDE_MODEL", "claude-opus-5-5");
    const c = await loadConfig();
    expect(c.claudeModel).toBe("claude-opus-5-5");
  });
});

describe("requireEnv", () => {
  it("未設定・空文字ならエラーにする", async () => {
    vi.resetModules();
    const { requireEnv } = await import("./config");
    vi.stubEnv("SOME_KEY", "");
    expect(() => requireEnv("SOME_KEY")).toThrow("SOME_KEY");
    vi.stubEnv("SOME_KEY", "value");
    expect(requireEnv("SOME_KEY")).toBe("value");
  });
});
