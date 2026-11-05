import "server-only"; // OpenAI の API キーを扱うため、ブラウザ向けのコードから読み込めないようにする
import OpenAI from "openai";
import { config, requireEnv } from "../config";

/** テストで差し替えられるよう、必要な部分だけを型にしたもの（OpenAI SDK がこの形を満たす） */
export type EmbeddingClient = {
  embeddings: {
    create(args: { model: string; input: string[] }): Promise<{
      data: { index: number; embedding: number[] }[];
    }>;
  };
};

// 1回のAPI呼び出しにまとめる件数。多すぎると上限(トークン数)に当たり、少なすぎると遅くなる
const BATCH_SIZE = 64;

let defaultClient: EmbeddingClient | undefined;

function getClient(): EmbeddingClient {
  // maxRetries: 429(利用制限)や5xx(一時障害)のとき、SDK が待ち時間を伸ばしながら自動で再試行する
  defaultClient ??= new OpenAI({ apiKey: requireEnv("OPENAI_API_KEY"), maxRetries: 5 });
  return defaultClient;
}

/** 複数のテキストをベクトルに変換する。結果は入力と同じ順序で返る。 */
export async function embedTexts(
  texts: string[],
  client: EmbeddingClient = getClient(),
): Promise<number[][]> {
  const vectors: number[][] = [];
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    const res = await client.embeddings.create({ model: config.embeddingModel, input: batch });

    if (res.data.length !== batch.length) {
      throw new Error(`Embedding の件数が一致しません（要求 ${batch.length} / 応答 ${res.data.length}）`);
    }
    for (const item of [...res.data].sort((a, b) => a.index - b.index)) {
      // DB の vector(1536) とずれると保存時に失敗するので、ここで気づけるようにする
      if (item.embedding.length !== config.embeddingDimensions) {
        throw new Error(
          `Embedding の次元数が想定外です（期待 ${config.embeddingDimensions} / 実際 ${item.embedding.length}）。モデル設定を確認してください`,
        );
      }
      vectors.push(item.embedding);
    }
  }
  return vectors;
}

/** 質問文など1件をベクトルに変換する */
export async function embedQuery(text: string, client?: EmbeddingClient): Promise<number[]> {
  const [vector] = await embedTexts([text], client);
  return vector;
}
