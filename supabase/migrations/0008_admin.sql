-- 管理画面のための追加
--
-- ① users.is_admin: 管理画面に入れる人。ログイン（Supabase Auth）した人が users.auth_user_id で
--    どの users の行に当たるかを引き、is_admin が true の人だけを管理者とする。
--    users テーブルは RLS 有効でポリシーなし（= service_role 以外は読み書きできない）なので、
--    一般のログインユーザーがこの列を書き換えて管理者になることはできない。
-- ② unassigned_documents(): 部署が判定できず、誰にも見えない状態の文書の一覧（管理者が確認して対応する）。
--    service_role 専用。

alter table users add column is_admin boolean not null default false;

create or replace function unassigned_documents(p_limit int default 100)
returns table (
  id uuid,
  title text,
  url text,
  customer text,
  doc_year int,
  synced_at timestamptz
)
language sql stable security definer
set search_path = public
as $$
  select d.id, d.title, d.url, d.customer, d.doc_year, d.synced_at
  from documents d
  where d.status = 'active'
    and not exists (select 1 from document_access da where da.document_id = d.id)
  order by d.synced_at desc
  limit least(greatest(p_limit, 1), 500)
$$;

revoke execute on function unassigned_documents from public, anon, authenticated;
grant execute on function unassigned_documents to service_role;
