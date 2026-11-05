-- RAG ナレッジ検索: 初期スキーマ
create extension if not exists vector;

create table departments (
  id serial primary key,
  name text not null unique
);

create table users (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid unique references auth.users(id) on delete set null,
  email text unique,
  slack_user_id text unique,
  display_name text
);

create table user_departments (
  user_id uuid not null references users(id) on delete cascade,
  department_id int not null references departments(id) on delete cascade,
  primary key (user_id, department_id)
);

create table documents (
  id uuid primary key default gen_random_uuid(),
  sharepoint_id text not null unique,
  title text not null,
  url text not null,
  file_type text not null,
  department_id int references departments(id),
  doc_date date,
  customer text,
  content_hash text,
  status text not null default 'active' check (status in ('active','deleted')),
  synced_at timestamptz not null default now()
);
create index on documents (department_id);
create index on documents (doc_date);
create index on documents (customer);

create table document_access (
  document_id uuid not null references documents(id) on delete cascade,
  department_id int not null references departments(id) on delete cascade,
  primary key (document_id, department_id)
);

create table chunks (
  id bigserial primary key,
  document_id uuid not null references documents(id) on delete cascade,
  section_title text,
  section_order int not null,
  content text not null,
  embedding vector(1536) not null,
  token_count int,
  embedding_model text not null
);
create index chunks_document_idx on chunks (document_id);
create index chunks_embedding_idx on chunks using hnsw (embedding vector_cosine_ops);

create table ingestion_runs (
  id bigserial primary key,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  total int default 0,
  succeeded int default 0,
  failed int default 0,
  status text not null default 'running' check (status in ('running','partial','done','error'))
);

create table ingestion_errors (
  id bigserial primary key,
  run_id bigint not null references ingestion_runs(id) on delete cascade,
  sharepoint_id text,
  title text,
  error_message text,
  created_at timestamptz not null default now()
);

-- Graph delta 同期の再開用
create table sync_state (
  key text primary key,
  value text,
  updated_at timestamptz not null default now()
);

create table query_logs (
  id bigserial primary key,
  user_id uuid references users(id) on delete set null,
  channel text not null check (channel in ('slack','web')),
  question text not null,
  answer text,
  source_chunk_ids bigint[],
  latency_ms int,
  feedback smallint,
  created_at timestamptz not null default now()
);

-- ===== RLS =====
create or replace function current_department_ids()
returns setof int
language sql stable security definer set search_path = public as $$
  select ud.department_id
  from user_departments ud
  join users u on u.id = ud.user_id
  where u.auth_user_id = auth.uid()
$$;

alter table departments enable row level security;
alter table users enable row level security;
alter table user_departments enable row level security;
alter table documents enable row level security;
alter table document_access enable row level security;
alter table chunks enable row level security;
alter table ingestion_runs enable row level security;
alter table ingestion_errors enable row level security;
alter table sync_state enable row level security;
alter table query_logs enable row level security;

create policy documents_select on documents for select to authenticated
  using (status = 'active' and exists (
    select 1 from document_access da
    where da.document_id = documents.id
      and da.department_id in (select current_department_ids())));

create policy chunks_select on chunks for select to authenticated
  using (exists (
    select 1 from documents d
    join document_access da on da.document_id = d.id
    where d.id = chunks.document_id and d.status = 'active'
      and da.department_id in (select current_department_ids())));

create policy departments_select on departments for select to authenticated using (true);
-- users / ingestion_* / sync_state / query_logs は service_role のみ（ポリシー無し=拒否）

-- ===== ベクトル検索 =====
-- service_role 専用。p_user_id（users.id）の所属部署で権限を明示フィルタ。
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
  customer text,
  content text,
  similarity float
)
language sql stable security definer set search_path = public as $$
  select c.id, d.id, d.title, d.url, c.section_title, d.doc_date, d.customer, c.content,
         1 - (c.embedding <=> query_embedding) as similarity
  from chunks c
  join documents d on d.id = c.document_id
  where d.status = 'active'
    and exists (
      select 1 from document_access da
      join user_departments ud on ud.department_id = da.department_id
      where da.document_id = d.id and ud.user_id = p_user_id)
    and (p_department_id is null or d.department_id = p_department_id)
    and (p_date_from is null or d.doc_date >= p_date_from)
    and (p_date_to is null or d.doc_date <= p_date_to)
    and (p_customer is null or d.customer ilike '%' || p_customer || '%')
  order by c.embedding <=> query_embedding
  limit match_count
$$;

revoke execute on function match_chunks from public, anon, authenticated;
grant execute on function match_chunks to service_role;
