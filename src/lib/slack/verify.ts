import { createHmac, timingSafeEqual } from "node:crypto";

// Slack が推奨する許容時間。古いリクエストを弾き、録っておいた通信の使い回し（リプレイ攻撃）を防ぐ
const MAX_AGE_SECONDS = 60 * 5;

type Input = {
  signingSecret: string;
  /** ヘッダー X-Slack-Request-Timestamp */
  timestamp: string | null;
  /** ヘッダー X-Slack-Signature（"v0=..."） */
  signature: string | null;
  /** 加工する前の本文そのまま（JSON に直して書き戻した文字列では署名が合わない） */
  rawBody: string;
  nowSeconds?: number;
};

/**
 * Slack から本当に届いたリクエストか確かめる。
 * Slack は「秘密鍵」と「時刻+本文」から署名を作って送ってくる。同じ計算をして一致すれば、
 * 秘密鍵を知る Slack からの送信で、途中で書き換えられてもいないと言える。
 */
export function verifySlackSignature({
  signingSecret,
  timestamp,
  signature,
  rawBody,
  nowSeconds = Math.floor(Date.now() / 1000),
}: Input): boolean {
  if (!signingSecret || !timestamp || !signature) return false;
  if (!/^\d+$/.test(timestamp)) return false;
  if (Math.abs(nowSeconds - Number(timestamp)) > MAX_AGE_SECONDS) return false;

  const expected = "v0=" + createHmac("sha256", signingSecret).update(`v0:${timestamp}:${rawBody}`).digest("hex");

  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  // 長さが違うと timingSafeEqual が例外になる。比較にかかる時間から中身を推測されない関数を使う
  return a.length === b.length && timingSafeEqual(a, b);
}
