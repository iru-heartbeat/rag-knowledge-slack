import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLocalFolderSource } from "./local";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "local-source-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const put = (rel: string, body = "x") => {
  const full = join(root, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, body);
};

describe("createLocalFolderSource.fetchChanges", () => {
  it("PDF と docx だけを再帰的に拾う。それ以外・Word の一時ファイル(~$)は除く", async () => {
    put("a.pdf");
    put("営業/2024/b.docx");
    put("c.pptx");
    put("memo.txt");
    put("~$b.docx");
    const page = await createLocalFolderSource(root).fetchChanges(null);

    const files = page.items.filter((i) => i.kind === "file");
    expect(files.map((f) => f.sharepointId).sort()).toEqual(["a.pdf", "営業/2024/b.docx"]);
    expect(files.find((f) => f.sharepointId === "a.pdf")).toMatchObject({
      title: "a.pdf",
      fileType: "pdf",
      folderPath: "",
    });
    expect(files.find((f) => f.sharepointId === "営業/2024/b.docx")).toMatchObject({
      title: "b.docx",
      fileType: "docx",
      folderPath: "/営業/2024",
    });
  });

  it("ファイルサイズ(バイト)を持つ", async () => {
    put("a.pdf", "12345");
    const [item] = (await createLocalFolderSource(root).fetchChanges(null)).items;
    expect(item).toMatchObject({ kind: "file", size: 5 });
  });

  it("出典リンクには、その場所を指す file:// のURLを付ける", async () => {
    put("a.pdf");
    const [item] = (await createLocalFolderSource(root).fetchChanges(null)).items;
    expect(item.kind === "file" && item.url.startsWith("file:///")).toBe(true);
  });

  it("1ページで完結する（nextCursor なし、finalCursor あり）", async () => {
    put("a.pdf");
    const page = await createLocalFolderSource(root).fetchChanges(null);
    expect(page.nextCursor).toBeNull();
    expect(page.finalCursor).not.toBeNull();
  });

  it("前回あって今回無いファイルは deleted で返す", async () => {
    put("a.pdf");
    put("b.pdf");
    const src = createLocalFolderSource(root);
    const first = await src.fetchChanges(null);

    rmSync(join(root, "b.pdf"));
    const second = await src.fetchChanges(first.finalCursor);
    expect(second.items.filter((i) => i.kind === "deleted")).toEqual([{ kind: "deleted", sharepointId: "b.pdf" }]);
    expect(second.items.filter((i) => i.kind === "file").map((i) => i.sharepointId)).toEqual(["a.pdf"]);
  });

  it("壊れたカーソルは最初からやり直す扱い（削除は報告しない）", async () => {
    put("a.pdf");
    const page = await createLocalFolderSource(root).fetchChanges("not json");
    expect(page.items.map((i) => i.kind)).toEqual(["file"]);
  });

  it("フォルダが存在しなければ、分かりやすいエラー", async () => {
    await expect(createLocalFolderSource(join(root, "nothing")).fetchChanges(null)).rejects.toThrow(/フォルダ/);
  });
});

describe("createLocalFolderSource.download", () => {
  it("IDのファイルの中身を返す", async () => {
    put("営業/b.pdf", "hello");
    const buf = await createLocalFolderSource(root).download("営業/b.pdf");
    expect(buf.toString()).toBe("hello");
  });

  it("フォルダの外を指すID（..）は拒否する", async () => {
    await expect(createLocalFolderSource(join(root, "sub")).download("../x.pdf")).rejects.toThrow();
    await expect(createLocalFolderSource(root).download("/etc/passwd")).rejects.toThrow();
  });
});
