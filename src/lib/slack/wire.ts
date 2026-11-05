import "server-only";
import { completeQuery, reserveQuery } from "../quota";
import { generateAnswer } from "../rag/answer";
import { retrieveChunks } from "../rag/retrieve";
import { getAdminClient } from "../supabase";
import { getSlackApi } from "./client";
import type { HandlerDeps } from "./handle";
import { resolveUserId } from "./user";

/** 本番用の部品（DB・Slack・OpenAI・Claude）をつなぎ合わせる */
export function createHandlerDeps(): HandlerDeps {
  const db = getAdminClient();
  const slack = getSlackApi();

  return {
    resolveUser: (slackUserId) => resolveUserId(db, slackUserId, slack.lookupEmail),
    begin: (userId, question) => reserveQuery(db, { userId, channel: "slack", question }),
    complete: (id, entry) => completeQuery(db, id, entry),
    // 権限の絞り込みは retrieveChunks → match_chunks(p_user_id) が行う。ここでは省略も上書きもしない
    retrieve: (userId, question) => retrieveChunks(db, { userId, question }),
    generate: (question, chunks) => generateAnswer(question, chunks),
    post: (msg) => slack.postMessage(msg),
  };
}
