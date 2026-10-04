-- Private storage for QA evidence images (design vs live crops) that the Parity app uploads
-- for a signed-in account. Nothing here is reachable with the public anon key:
--   * the bucket has no storage policies, so only the service role can read or write objects;
--   * the table has row level security enabled and no policies, and client roles have no grants.
-- Images are served only by the qa-evidence edge function, by their unguessable id, until they
-- expire. There is no way to list them.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('qa-evidence', 'qa-evidence', false, 10485760, array['image/webp', 'image/png', 'image/jpeg'])
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create table public.qa_evidence (
  id text primary key check (id ~ '^[A-Za-z0-9_-]{22}$'),
  auth_user_id uuid not null references auth.users(id) on delete cascade,
  object_path text not null unique,
  content_type text not null check (content_type in ('image/webp', 'image/png', 'image/jpeg')),
  byte_size integer not null check (byte_size between 1 and 10485760),
  label text not null default '' check (char_length(label) <= 200),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create index qa_evidence_expires_idx on public.qa_evidence (expires_at);
create index qa_evidence_user_created_idx on public.qa_evidence (auth_user_id, created_at desc);

alter table public.qa_evidence enable row level security;
revoke all on public.qa_evidence from public, anon, authenticated;
grant select, insert, update, delete on public.qa_evidence to service_role;

comment on table public.qa_evidence is
  'Index of uploaded QA evidence images. Client roles have no access; the qa-evidence edge function serves images by id until expires_at.';
