import "server-only"; // Slack ボットのトークンを扱うため、ブラウザ向けのコードから読み込めないようにする
import { WebClient } from "@slack/web-api";
import { requireEnv } from "../config";

export type SlackApi = {
  postMessage(msg: {
    channel: string;
    threadTs: string;
    /** 指定すると、そのユーザーにだけ見える投稿（chat.postEphemeral）になる */
    ephemeralUserId?: string;
    text: string;
    blocks?: unknown[];
  }): Promise<void>;
  /** Slack に登録されたメールアドレス。取れなければ null */
  lookupEmail(slackUserId: string): Promise<string | null>;
};

let defaultApi: SlackApi | undefined;

export function getSlackApi(): SlackApi {
  if (!defaultApi) {
    const web = new WebClient(requireEnv("SLACK_BOT_TOKEN"));
    defaultApi = {
      async postMessage({ channel, threadTs, ephemeralUserId, text, blocks }) {
        if (ephemeralUserId) {
          // 質問者にだけ見える。postEphemeral は unfurl の指定を持たない
          await web.chat.postEphemeral({
            channel,
            user: ephemeralUserId,
            thread_ts: threadTs,
            text,
            blocks: blocks as never,
          });
          return;
        }
        // unfurl を切る: 出典リンクの下に巨大なプレビューが並んで読みにくくなるのを防ぐ
        await web.chat.postMessage({
          channel,
          thread_ts: threadTs,
          text,
          // blocks の型は Slack SDK 側が細かく決めているが、こちらで作る形は format.ts のテストで固定している
          blocks: blocks as never,
          unfurl_links: false,
          unfurl_media: false,
        });
      },
      async lookupEmail(slackUserId) {
        // 要スコープ users:read.email。権限不足などの失敗は例外のまま上へ伝える（未登録と取り違えない）
        const res = await web.users.info({ user: slackUserId });
        return res.user?.profile?.email ?? null;
      },
    };
  }
  return defaultApi;
}
