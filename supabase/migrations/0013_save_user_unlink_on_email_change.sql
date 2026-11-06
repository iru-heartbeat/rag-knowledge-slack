-- save_user: メールアドレスを別のものに変えたとき、Slack とログインの紐づけを外す（コードレビュー指摘）。
--
-- 紐づけは「メールアドレスが一致した人」に対して結ぶ。その行のメールを別人のものに付け替えると、
-- 以前の紐づけ（slack_user_id / auth_user_id）が残り、前の人がその行の部署権限で検索し続けられる。
-- 一方、新しい人は「すでに紐づいた行」を拒否されるため、自分では結べない。
-- 大文字小文字・前後の空白だけの違いは、同じメールとみなして紐づけを保つ。
-- 名前や部署だけの変更でも紐づけは保つ。

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
  v_old_email text;
begin
  if p_id is null then
    insert into users (email, display_name) values (p_email, p_display_name) returning id into v_id;
  else
    select email into v_old_email from users where id = p_id for update;
    if not found then
      raise exception 'user not found' using errcode = 'P0002';
    end if;

    if lower(btrim(coalesce(v_old_email, ''))) is distinct from lower(btrim(coalesce(p_email, ''))) then
      update users
         set email = p_email, display_name = p_display_name, slack_user_id = null, auth_user_id = null
       where id = p_id returning id into v_id;
    else
      update users set email = p_email, display_name = p_display_name where id = p_id returning id into v_id;
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
