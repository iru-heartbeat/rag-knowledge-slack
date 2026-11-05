-- query_logs(user_id, created_at) の索引（コードレビュー指摘）
--
-- 質問回数の上限（src/lib/quota.ts）は、質問のたびに「このユーザーの直近1時間の記録数」を数える。
-- 索引がないとログが増えるほど全件を走査して遅くなるので、その条件に合わせた索引を作る。

create index query_logs_user_created_idx on query_logs (user_id, created_at);
