import "server-only"; // ローカルのファイルを読むので、ブラウザ向けのコードから読み込めないようにする
import { readFile, readdir, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { ChangePage, DocumentSource, SourceItem } from "./types";

type FileItem = Extract<SourceItem, { kind: "file" }>;

/**
 * ローカルのフォルダを文書の入手元にする（SharePoint を用意できない環境での代用）。
 * 文書ID はフォルダからの相対パス。ファイルの変更は取り込み側が中身の指紋で見分けるので、
 * ここでは常に全ファイルを返し、「前回あって今回無いもの」だけを削除として知らせる。
 */
export function createLocalFolderSource(rootDir: string): DocumentSource {
  const root = resolve(rootDir);

  return {
    async fetchChanges(cursor) {
      const files = await listFiles(root);
      const previous = parseCursor(cursor);
      const current = new Set(files.map((f) => f.sharepointId));
      const deleted: SourceItem[] = previous
        .filter((id) => !current.has(id))
        .map((id) => ({ kind: "deleted", sharepointId: id }));

      const page: ChangePage = {
        items: [...files, ...deleted],
        nextCursor: null, // ローカルは1ページで完結する
        finalCursor: JSON.stringify([...current].sort()),
      };
      return page;
    },

    async download(id) {
      const full = resolve(root, id);
      // "../" や絶対パスでフォルダの外のファイルを読ませないための確認
      const rel = relative(root, full);
      if (isAbsolute(id) || rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
        throw new Error(`取り込みフォルダの外は読めません: ${id}`);
      }
      return readFile(full);
    },
  };
}

/** 壊れたカーソルは「初回」と同じ扱い。取り込みは冪等なので、やり直しになるだけで害はない */
function parseCursor(cursor: string | null): string[] {
  if (!cursor) return [];
  try {
    const v: unknown = JSON.parse(cursor);
    return Array.isArray(v) && v.every((x) => typeof x === "string") ? v : [];
  } catch {
    return [];
  }
}

async function listFiles(root: string): Promise<FileItem[]> {
  try {
    if (!(await stat(root)).isDirectory()) throw new Error();
  } catch {
    throw new Error(`取り込み元のフォルダが見つかりません: ${root}`);
  }

  const out: FileItem[] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      // isFile() はシンボリックリンクを含まない（リンク経由でフォルダ外を読まないため）
      if (!entry.isFile() || entry.name.startsWith("~$")) continue; // "~$" は Word が開いている間の一時ファイル

      const lower = entry.name.toLowerCase();
      const fileType = lower.endsWith(".pdf") ? "pdf" : lower.endsWith(".docx") ? "docx" : null;
      if (!fileType) continue;

      const info = await stat(full);
      const rel = relative(root, full).split(sep).join("/");
      const slash = rel.lastIndexOf("/");
      out.push({
        kind: "file",
        sharepointId: rel,
        title: entry.name,
        url: pathToFileURL(full).href,
        fileType,
        folderPath: slash < 0 ? "" : "/" + rel.slice(0, slash),
        lastModified: info.mtime.toISOString(),
        size: info.size,
      });
    }
  }
  await walk(root);
  return out;
}
