// 設定値を1か所に集約する。チューニングはこのファイルだけ触れば済むようにする。

/** 必須の環境変数を取得。未設定なら起動時に分かるよう明確なエラーにする。 */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`環境変数 ${name} が設定されていません`);
  return value;
}

export const config = {
  // `??` は未設定(undefined)のときしか既定値にならない。`CLAUDE_MODEL=` のように空で書かれると
  // 空文字のままAPIに渡って失敗するため、空文字も既定値に戻す `||` を使う
  claudeModel: process.env.CLAUDE_MODEL || "claude-sonnet-5-5",
  embeddingModel: process.env.EMBEDDING_MODEL || "text-embedding-3-small",
  // DB の vector(1536) の次元数。モデルを変えて次元が変わると、embed.ts の検査が
  // 「次元数が想定外」と明確なエラーにする（その場合は DB 側の列も作り直しが必要）
  embeddingDimensions: 1536,

  // 取り込みの「規則」（部署・客先・日付の抽出、見出しの判定、チャンク分割など）の版数。
  // これらを変えたら必ず +1 する。保存済みの文書の版数と違えば、内容が同じでも次回の同期で再処理される
  pipelineVersion: 1,

  chunk: {
    maxChars: 800, // 1チャンクの最大文字数
    overlapChars: 100, // 再分割時に前後で重ねる文字数
  },

  search: {
    topK: 8, // 回答の根拠として使うチャンク数
    // これ未満の類似度のチャンクは根拠にしない（無関係な文書で無理に答えないため）。
    // 値の根拠（サンプル4件での実測）: 関係のある質問の上位は 0.49〜0.72、
    // 閲覧権限のない部署の話題(人事・IT)で拾ってしまう無関係なチャンクは最大 0.38、無関係な質問は 0.16 以下。
    // 5,000件規模では分布が変わるので、全件投入後に scripts/try-search.ts で見直すこと
    minSimilarity: 0.4,
  },

  limits: {
    // 1人あたりの質問回数の上限（直近1時間）。連打で OpenAI / Claude の費用が無制限にかかるのを防ぐ
    questionsPerHour: 60,
    // 取り込むファイルの大きさの上限。大きすぎると関数のメモリが足りず、同期ごと落ちる
    maxFileBytes: 50 * 1024 * 1024,
  },

  answer: {
    maxTokens: 2048, // Claude の回答の最大トークン数（30秒目標のため上限を設ける。思考の分も含まれるので余裕を持たせる）
  },
} as const;
