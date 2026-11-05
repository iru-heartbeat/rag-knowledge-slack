-- match_chunks: 部署での絞り込みを、閲覧権限の表（document_access）で判定するよう修正（コードレビュー指摘）
--
-- これまでは documents.department_id（取り込み時に「主たる部署」＝併記の先頭だけを入れた列）と比べていた。
-- 「部署: 営業・人事」のように併記された文書は、権限(document_access)には営業・人事の両方が入っているのに、
-- 人事の人が「部署=人事」で絞ると、主たる部署が営業のため結果から消えていた。
-- 権限と同じ表で判定することで、「その部署が閲覧できる文書」で絞り込めるようにする。
-- それ以外（権限の絞り込み・日付・客先・iterative_scan の設定）は 0006 と同じ。

select '[1,2,3]'::vector;

create or replace function match_chunks(
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
language sql stable security definer
set search_path = public
set hnsw.iterative_scan = 'strict_order'
set hnsw.ef_search = 100
set hnsw.max_scan_tuples = 100000
as $$
  select c.id, d.id, d.title, d.url, c.section_title, d.doc_date, d.doc_year, d.customer, c.content,
         1 - (c.embedding <=> query_embedding) as similarity
  from chunks c
  join documents d on d.id = c.document_id
  where d.status = 'active'
    and exists (
      select 1 from document_access da
      join user_departments ud on ud.department_id = da.department_id
      where da.document_id = d.id and ud.user_id = p_user_id)
    and (p_department_id is null
         or exists (
           select 1 from document_access dd
           where dd.document_id = d.id and dd.department_id = p_department_id))
    -- 年月日がある文書は日付で、年だけの文書は年で比較する。日付も年も無い文書は日付指定時に除外
    and (p_date_from is null
         or d.doc_date >= p_date_from
         or (d.doc_date is null and d.doc_year >= extract(year from p_date_from)))
    and (p_date_to is null
         or d.doc_date <= p_date_to
         or (d.doc_date is null and d.doc_year <= extract(year from p_date_to)))
    and (p_customer is null or position(lower(p_customer) in lower(d.customer)) > 0)
  order by c.embedding <=> query_embedding
  limit match_count
$$;

revoke execute on function match_chunks from public, anon, authenticated;
grant execute on function match_chunks to service_role;
