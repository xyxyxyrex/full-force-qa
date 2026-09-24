create table public.parity_feedback (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid not null references auth.users(id) on delete cascade,
  contact_email text not null check (char_length(contact_email) between 3 and 320),
  kind text not null check (kind in ('bug', 'feature', 'general')),
  title text not null check (char_length(title) between 4 and 120),
  details text not null check (char_length(details) between 10 and 4000),
  area text not null check (area in ('dashboard', 'edit', 'live', 'audit', 'automate', 'notes', 'settings', 'other')),
  app_version text not null check (char_length(app_version) between 1 and 40),
  platform text not null check (platform in ('win32', 'darwin', 'linux')),
  status text not null default 'new' check (status in ('new', 'reviewing', 'resolved')),
  created_at timestamptz not null default now()
);

create index parity_feedback_user_created_idx on public.parity_feedback (auth_user_id, created_at desc);
create index parity_feedback_status_created_idx on public.parity_feedback (status, created_at desc);

alter table public.parity_feedback enable row level security;
revoke all on public.parity_feedback from public, anon, authenticated;
grant select, insert, update, delete on public.parity_feedback to service_role;

comment on table public.parity_feedback is
  'Private Parity product feedback submitted by verified accounts. Read and triage in the Supabase dashboard; client roles have no direct access.';
