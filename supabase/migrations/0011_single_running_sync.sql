-- 同期の二重起動を、DB の制約で確実に防ぐ（コードレビュー指摘）
--
-- 「実行中の同期があるか調べてから記録を作る」方式は、調べる操作と作る操作が別々なので、
-- ほぼ同時に起動した2つが両方通り抜ける。status='running' の行は同時に1件までという制約にして、
-- 記録の作成そのものを排他にする（2つ目の insert は unique 違反=23505 で失敗する）。
-- 式インデックスの (true) は、全ての running 行が「同じ値」になるようにするための定数。

create unique index ingestion_runs_single_running
  on ingestion_runs ((true))
  where status = 'running';
