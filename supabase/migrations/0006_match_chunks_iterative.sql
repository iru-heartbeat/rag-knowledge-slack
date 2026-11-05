-- match_chunks の2つの修正（コードレビュー指摘）
--
-- ① ベクトル索引（HNSW）は「近い順に ef_search 件」を取り出した後で、権限・部署・期間・客先の条件で絞り込む。
--    取り出した40件の大半が見てはいけない文書だと、8件要求しても数件（最悪0件）しか返らず、
--    見てよい文書に答えがあるのに「見つかりません」になる。
--    → iterative_scan: 条件を満たす行が足りない間、索引を探し続ける（pgvector 0.8 以降）。
--      順序を崩さないよう strict_order。
-- ② p_customer を ILIKE のパターンに入れていたため、% や _ がワイルドカードとして働いた
--    （'%' だけで全文書に一致）。→ 文字どおりの部分一致（position）にする。
-- pgvector を先に読み込ませる。読み込み前だと、関数の SET に書いた hnsw.* の設定項目が
-- 「未知の項目」として扱われ、権限エラー（permission denied to set parameter）になる。
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
    and (p_department_id is null or d.department_id = p_department_id)
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
