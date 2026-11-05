-- 管理画面のユーザー登録・更新用。ユーザー本体と所属部署を1つのトランザクションで保存する。
--
-- ユーザーと部署を別々に保存すると、途中で失敗したとき「部署のないユーザー」や
-- 「古い部署のまま残ったユーザー」が生まれる。部署は権限に直結するため、全部成功か全部失敗にする。
--  - p_id が null なら新規登録、あれば更新（所属部署は p_department_ids で置き換える）
--  - is_admin は触らない（管理者の追加・解除は画面からはできない。権限昇格の経路を作らないため）
--  - メールアドレスの重複は unique 制約が 23505、存在しない部署は外部キー制約が 23503 で止める
-- service_role 専用。

create or replace function save_user(
  p_id uuid,
  p_email text,
  p_display_name text,
  p_department_ids int[]
)
returns uuid
language plpgsql security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if p_id is null then
    insert into users (email, display_name) values (p_email, p_display_name) returning id into v_id;
  else
    update users set email = p_email, display_name = p_display_name where id = p_id returning id into v_id;
    if v_id is null then
      raise exception 'user not found' using errcode = 'P0002';
    end if;
  end if;

  delete from user_departments where user_id = v_id;
  insert into user_departments (user_id, department_id)
  select v_id, d from (select distinct unnest(coalesce(p_department_ids, '{}'::int[])) as d) s;

  return v_id;
end
$$;

revoke execute on function save_user from public, anon, authenticated;
grant execute on function save_user to service_role;
