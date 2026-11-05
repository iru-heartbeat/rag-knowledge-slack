-- 文書の作成日は「年月日が分かれば doc_date、無ければ年だけ doc_year」の2段構え。
-- doc_date がある文書も doc_year を必ず持つ（年での絞り込みを一本化するため）。
alter table documents add column doc_year int check (doc_year between 1900 and 2100);
create index on documents (doc_year);

-- 返り値の列が増えるため作り直す
drop function match_chunks(vector, uuid, int, int, date, date, text);

create function match_chunks(
  query_embedding vector(1536),
  p_user_id uuid,
  match_count int default 8,
  p_department_id int default null,
  p_date_from date default null,
  p_date_to date default null,
  p_customer text default null
)
returns table (
  chunk_id bigint,
  document_id uuid,
  title text,
  url text,
  section_title text,
  doc_date date,
  doc_year int,
  customer text,
  content text,
  similarity float
)
language sql stable security definer set search_path = public as $$
  select c.id, d.id, d.title, d.url, c.section_title, d.doc_date, d.doc_year, d.customer, c.content,
         1 - (c.embedding <=> query_embedding) as similarity
  from chunks c
  join documents d on d.id = c.document_id
  where d.status = 'active'
    and exists (
      select 1 from document_access da
      join user_departments ud on ud.department_id = da.department_id
      where da.document_id = d.id and ud.user_id = p_user_id)
    and (p_department_id is null or d.department_id = p_department_id)
    -- 年月日がある文書は日付で、年だけの文書は年で比較する。日付も年も無い文書は日付指定時に除外
    and (p_date_from is null
         or d.doc_date >= p_date_from
         or (d.doc_date is null and d.doc_year >= extract(year from p_date_from)))
    and (p_date_to is null
         or d.doc_date <= p_date_to
         or (d.doc_date is null and d.doc_year <= extract(year from p_date_to)))
    and (p_customer is null or d.customer ilike '%' || p_customer || '%')
  order by c.embedding <=> query_embedding
  limit match_count
$$;

revoke execute on function match_chunks from public, anon, authenticated;
grant execute on function match_chunks to service_role;
