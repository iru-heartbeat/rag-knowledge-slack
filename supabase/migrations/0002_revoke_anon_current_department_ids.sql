-- 未ログイン(anon)が部署判定関数を直接呼べないようにする。
-- authenticated は RLS ポリシーの評価で必要なため残す。
revoke execute on function current_department_ids() from public, anon;
grant execute on function current_department_ids() to authenticated, service_role;
