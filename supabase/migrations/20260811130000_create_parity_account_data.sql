create table if not exists public.parity_accounts (
  owner_key text primary key check (owner_key ~ '^monday:[0-9]+$'),
  monday_user_id text not null unique check (monday_user_id ~ '^[0-9]+$'),
  display_name text not null default '' check (char_length(display_name) <= 200),
  email text not null default '' check (char_length(email) <= 320),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.parity_user_state (
  owner_key text primary key references public.parity_accounts(owner_key) on delete cascade,
  data jsonb not null default '{}'::jsonb check (jsonb_typeof(data) = 'object'),
  updated_at timestamptz not null default now()
);

create table if not exists public.parity_projects (
  owner_key text not null references public.parity_accounts(owner_key) on delete cascade,
  project_id text not null check (char_length(project_id) between 1 and 200),
  data jsonb not null check (jsonb_typeof(data) = 'object'),
  updated_at timestamptz not null default now(),
  primary key (owner_key, project_id)
);

create table if not exists public.parity_notes (
  owner_key text not null references public.parity_accounts(owner_key) on delete cascade,
  note_id text not null check (char_length(note_id) between 1 and 200),
  data jsonb not null check (jsonb_typeof(data) = 'object'),
  updated_at timestamptz not null default now(),
  primary key (owner_key, note_id)
);

create index if not exists parity_projects_owner_updated_idx
  on public.parity_projects (owner_key, updated_at desc);

create index if not exists parity_notes_owner_updated_idx
  on public.parity_notes (owner_key, updated_at desc);

alter table public.parity_accounts enable row level security;
alter table public.parity_user_state enable row level security;
alter table public.parity_projects enable row level security;
alter table public.parity_notes enable row level security;

revoke all on public.parity_accounts from anon, authenticated;
revoke all on public.parity_user_state from anon, authenticated;
revoke all on public.parity_projects from anon, authenticated;
revoke all on public.parity_notes from anon, authenticated;

comment on table public.parity_accounts is
  'Monday identities verified by the parity-account Edge Function. No client role has direct access.';
comment on table public.parity_user_state is
  'Account-scoped Parity settings, folders, filters, and navigation preferences.';
comment on table public.parity_projects is
  'Account-scoped project metadata. Captures and thumbnails remain local to the desktop device.';
comment on table public.parity_notes is
  'Account-scoped rich-text notes. Attachment bytes remain on the desktop device.';

create or replace function public.merge_parity_user_state(
  p_owner_key text,
  p_patch jsonb
)
returns timestamptz
language plpgsql
security definer
set search_path = public
as $$
declare
  changed_at timestamptz := now();
begin
  if jsonb_typeof(p_patch) <> 'object' then
    raise exception 'State patch must be a JSON object';
  end if;
  insert into public.parity_user_state (owner_key, data, updated_at)
  values (p_owner_key, p_patch, changed_at)
  on conflict (owner_key) do update
    set data = parity_user_state.data || excluded.data,
        updated_at = changed_at;
  return changed_at;
end;
$$;

revoke all on function public.merge_parity_user_state(text, jsonb) from public, anon, authenticated;
grant execute on function public.merge_parity_user_state(text, jsonb) to service_role;
