-- 文書1件を「全部成功か、全部なし」で保存する関数。
-- Supabase のクライアントにはトランザクションが無く、「チャンク削除→追加」を順に呼ぶと
-- 途中で失敗した文書が壊れた状態（チャンク欠落・権限なし）で残るため、DB 内の1関数にまとめる。
create or replace function upsert_document(
  p_doc jsonb,              -- sharepoint_id, title, url, file_type, customer, doc_date, doc_year, content_hash
  p_department_ids int[],   -- 閲覧を許可する部署。空配列なら誰にも見せない（先頭を主たる部署 department_id とする）
  p_chunks jsonb            -- [{section_title, section_order, content, embedding:[...], token_count, embedding_model}]
)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_id uuid;
begin
  insert into documents
    (sharepoint_id, title, url, file_type, department_id, doc_date, doc_year, customer, content_hash, status, synced_at)
  values
    (p_doc->>'sharepoint_id', p_doc->>'title', p_doc->>'url', p_doc->>'file_type',
     p_department_ids[1], (p_doc->>'doc_date')::date, (p_doc->>'doc_year')::int,
     p_doc->>'customer', p_doc->>'content_hash', 'active', now())
  on conflict (sharepoint_id) do update set
    title = excluded.title,
    url = excluded.url,
    file_type = excluded.file_type,
    department_id = excluded.department_id,
    doc_date = excluded.doc_date,
    doc_year = excluded.doc_year,
    customer = excluded.customer,
    content_hash = excluded.content_hash,
    status = 'active',            -- 一度削除扱いになった文書が復活した場合
    synced_at = now()
  returning id into v_id;

  -- 更新時は古いチャンク・権限を入れ替える（同じ関数内なので、途中で失敗すれば全て元に戻る）
  delete from chunks where document_id = v_id;
  insert into chunks (document_id, section_title, section_order, content, embedding, token_count, embedding_model)
  select v_id, c->>'section_title', (c->>'section_order')::int, c->>'content',
         (c->>'embedding')::vector, (c->>'token_count')::int, c->>'embedding_model'
  from jsonb_array_elements(p_chunks) as c;

  delete from document_access where document_id = v_id;
  insert into document_access (document_id, department_id)
  select v_id, d from unnest(p_department_ids) as d;

  return v_id;
end
$$;

revoke execute on function upsert_document from public, anon, authenticated;
grant execute on function upsert_document to service_role;
