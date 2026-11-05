/**
 * 入手元で消えている（404/410）など、待ってもやり直しても取れないファイル。
 * 同期処理は、これを「やり直しても直らない失敗」として扱い、他のファイルを止めない。
 */
export class PermanentSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentSourceError";
  }
}

/** 取り込み対象のファイル（PDF / Word）、または削除の知らせ */
export type SourceItem =
  | {
      kind: "file";
      /** 入手元の中で変わらない文書ID（SharePoint なら項目ID、ローカルならフォルダからの相対パス） */
      sharepointId: string;
      title: string;
      /** 出典リンク */
      url: string;
      fileType: "pdf" | "docx";
      /** 入手元のルートからのフォルダ位置。例: "/営業/2024"（部署の決定ルール Q-01 の手がかり） */
      folderPath: string;
      lastModified: string | null;
      /** ファイルの大きさ（バイト）。分からなければ null / 省略 */
      size?: number | null;
    }
  | { kind: "deleted"; sharepointId: string };

/** 変更一覧の1ページ分。Vercel の実行時間制限に合わせ、小分けにして取り、途中から再開できる形にする */
export type ChangePage = {
  items: SourceItem[];
  /** まだ続きがあるときの次ページの目印 */
  nextCursor: string | null;
  /** 最後のページでだけ返る。次回の同期はここから始めると、変更分だけ取れる */
  finalCursor: string | null;
};

/**
 * 文書の入手元の共通の窓口。SharePoint でもローカルフォルダでも、取り込み側はこれだけを見る。
 * 入手元を差し替えても、取り込み（パイプライン）や同期の処理は変えずに済む。
 */
export type DocumentSource = {
  /** cursor が null なら最初から。 */
  fetchChanges(cursor: string | null): Promise<ChangePage>;
  download(id: string): Promise<Buffer>;
};
