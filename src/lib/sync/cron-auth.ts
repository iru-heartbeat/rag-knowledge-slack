import { timingSafeEqual } from "node:crypto";

/**
 * 同期の入口を呼んでよい相手か確かめる。
 * Vercel の Cron は、環境変数 CRON_SECRET があると「Authorization: Bearer <CRON_SECRET>」を自動で付けて呼ぶ。
 * サーバー側の合言葉が未設定・空のときは、設定漏れで誰でも呼べる状態にならないよう、常に断る。
 */
export function isAuthorizedCron(authorization: string | null, secret: string | undefined): boolean {
  if (!secret) return false;
  const expected = Buffer.from(`Bearer ${secret}`);
  const actual = Buffer.from(authorization ?? "");
  // 長さが違うと timingSafeEqual は例外になる。比較時間から中身を推測されない関数を使う
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
