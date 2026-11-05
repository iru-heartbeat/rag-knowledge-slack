import type { AnswerResult } from "../rag/answer";
import type { RetrievedChunk } from "../rag/retrieve";
import { formatReply, type SlackReply } from "./format";

export type SlackQuestion = {
  slackUserId: string;
  channel: string;
  threadTs: string;
  text: string;
  /** ボットへの DM か。false（チャンネルでのメンション）の返信は、質問者にだけ見える形にする */
  isDirect: boolean;
};

/** 外部との接点をすべて引数にして、テストでは偽物に差し替えられるようにしたもの */
export type HandlerDeps = {
  /** Slack ユーザー → users.id。登録されていなければ null */
  resolveUser(slackUserId: string): Promise<string | null>;
  /** 質問の記録を作る（外部APIを呼ぶ前に）。1時間あたりの上限を超えていれば null（連打による費用の増加を防ぐ） */
  begin(userId: string, question: string): Promise<number | null>;
  /** 回答・根拠チャンク・所要時間を、begin で作った記録に書き足す */
  complete(id: number, entry: { answer: string; sourceChunkIds: number[]; latencyMs: number }): Promise<void>;
  retrieve(userId: string, question: string): Promise<RetrievedChunk[]>;
  generate(question: string, chunks: RetrievedChunk[]): Promise<AnswerResult>;
  /** ephemeralUserId があれば、そのユーザーにだけ見える投稿にする（chat.postEphemeral） */
  post(
    msg: { channel: string; threadTs: string; ephemeralUserId?: string } & Partial<SlackReply> & { text: string },
  ): Promise<void>;
};

const MSG_UNREGISTERED =
  "このSlackアカウントは、まだナレッジ検索の利用者として登録されていません。管理者に登録を依頼してください。（Slack に登録されている会社のメールアドレスで照合します）";
const MSG_QUOTA = "短い間に質問が続いたため、しばらく時間をおいてからもう一度お試しください。";
const MSG_EMPTY = "質問を入力してください。例: 「@ナレッジ検索 地方銀行向けDX提案のアプローチは？」";
const MSG_ERROR = "エラーが発生したため、回答できませんでした。時間をおいてもう一度お試しください。";

/** 「<@U123> 質問」から、メンション部分を除いて質問だけにする */
export function stripMentions(text: string): string {
  return text.replace(/<@[A-Z0-9]+(?:\|[^>]*)?>/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Slack の質問1件を処理して、スレッドに返信する。
 * バックグラウンドで動くため、例外は外に出さない（出しても誰も受け取らず、ユーザーには無言になるだけ）。
 * 失敗したときは、内部の詳細（キーやスタックトレース）を含まない定型文だけを返す。
 */
export async function handleQuestion(msg: SlackQuestion, deps: HandlerDeps): Promise<void> {
  // チャンネルには部署の違う人もいる。回答（他部署の文書の要約を含みうる）は質問者にだけ見せる。
  // DM は本人しか見ないので通常の投稿でよい
  const ephemeralUserId = msg.isDirect ? undefined : msg.slackUserId;
  const reply = (text: string, extra: Partial<SlackReply> = {}) =>
    safely("返信の投稿", () => deps.post({ channel: msg.channel, threadTs: msg.threadTs, ephemeralUserId, text, ...extra }));

  try {
    const userId = await deps.resolveUser(msg.slackUserId);
    if (!userId) return await reply(MSG_UNREGISTERED);

    const question = stripMentions(msg.text);
    if (!question) return await reply(MSG_EMPTY);
    const logId = await deps.begin(userId, question);
    if (logId === null) return await reply(MSG_QUOTA);

    const startedAt = Date.now();
    const chunks = await deps.retrieve(userId, question);
    const result = await deps.generate(question, chunks);

    const formatted = formatReply(result);
    await deps.post({ channel: msg.channel, threadTs: msg.threadTs, ephemeralUserId, ...formatted });

    // 記録の失敗で、返信済みの回答を取り消す必要はない
    await safely("質問ログの保存", () =>
      deps.complete(logId, {
        answer: result.answer,
        sourceChunkIds: chunks.map((c) => c.chunkId),
        latencyMs: Date.now() - startedAt,
      }),
    );
  } catch (e) {
    console.error("Slack の質問の処理に失敗しました:", e);
    await reply(MSG_ERROR);
  }
}

async function safely(what: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    console.error(`${what}に失敗しました:`, e);
  }
}
