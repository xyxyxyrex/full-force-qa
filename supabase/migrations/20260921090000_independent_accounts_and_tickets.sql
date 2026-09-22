-- Additive: legacy clients and their Monday-owned rows remain valid.
alter table public.parity_accounts drop constraint parity_accounts_owner_key_check;
alter table public.parity_accounts add constraint parity_accounts_owner_key_check
  check (owner_key ~ '^monday:[0-9]+$' or owner_key ~ '^parity:[0-9a-f-]{36}$');
alter table public.parity_accounts alter column monday_user_id drop not null;
alter table public.parity_accounts add column auth_user_id uuid unique references auth.users(id);

create table public.parity_tickets (
  owner_key text not null references public.parity_accounts(owner_key) on delete cascade,
  ticket_id text not null check (char_length(ticket_id) between 1 and 500),
  data jsonb not null check (jsonb_typeof(data) = 'object'),
  revision bigint not null default 1 check (revision > 0),
  updated_at timestamptz not null default now(),
  primary key (owner_key, ticket_id)
);
create unique index parity_tickets_source_identity on public.parity_tickets
  (owner_key, (data #>> '{source,provider}'), (data #>> '{source,connectionId}'), (data #>> '{source,externalId}'));
alter table public.parity_tickets enable row level security;
revoke all on public.parity_tickets from public, anon, authenticated;
grant all on public.parity_tickets to service_role;

create or replace function public.initialize_parity_account(
  p_auth_user_id uuid, p_email text, p_name text, p_monday_id text default null
) returns public.parity_accounts
language plpgsql security definer set search_path = public as $$
declare account public.parity_accounts;
begin
  if p_auth_user_id is null then raise exception 'Verified identity required'; end if;
  perform pg_advisory_xact_lock(hashtextextended('parity-auth:' || p_auth_user_id::text, 0));
  select * into account from parity_accounts where auth_user_id = p_auth_user_id;
  if found then
    if p_monday_id is not null and account.monday_user_id is distinct from p_monday_id then
      raise exception 'This sign-in already owns another workspace. Workspaces cannot be merged.';
    end if;
    return account;
  end if;
  if p_monday_id is not null then
    if p_monday_id !~ '^[0-9]+$' then raise exception 'Invalid Monday identity'; end if;
    perform pg_advisory_xact_lock(hashtextextended('parity-monday:' || p_monday_id, 0));
    select * into account from parity_accounts where monday_user_id = p_monday_id for update;
    if not found then raise exception 'No existing Monday workspace was found. Start a new workspace instead.'; end if;
    if account.auth_user_id is not null then raise exception 'This workspace is already linked to another Parity sign-in.'; end if;
    update parity_accounts set auth_user_id = p_auth_user_id, updated_at = now()
      where owner_key = account.owner_key returning * into account;
  else
    insert into parity_accounts(owner_key, auth_user_id, display_name, email)
      values ('parity:' || p_auth_user_id::text, p_auth_user_id, left(p_name, 200), left(p_email, 320)) returning * into account;
  end if;
  return account;
end;
$$;
revoke all on function public.initialize_parity_account(uuid,text,text,text) from public, anon, authenticated;
grant execute on function public.initialize_parity_account(uuid,text,text,text) to service_role;

create or replace function public.save_parity_ticket(p_owner_key text, p_ticket jsonb, p_expected_revision bigint)
returns jsonb language plpgsql security definer set search_path = public as $$
declare existing public.parity_tickets; next_revision bigint; ticket_id_value text := p_ticket->>'id';
begin
  if jsonb_typeof(p_ticket) <> 'object' or ticket_id_value is null or p_expected_revision is null or p_expected_revision < 0 then raise exception 'Invalid ticket'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_owner_key || ':' || ticket_id_value, 0));
  select * into existing from parity_tickets where owner_key = p_owner_key and ticket_id = ticket_id_value for update;
  if coalesce(existing.revision, 0) <> p_expected_revision then
    return jsonb_build_object('conflict', true, 'ticket', existing.data, 'revision', existing.revision);
  end if;
  next_revision := p_expected_revision + 1;
  insert into parity_tickets(owner_key, ticket_id, data, revision)
    values(p_owner_key, ticket_id_value, p_ticket, next_revision)
    on conflict(owner_key, ticket_id) do update set data = excluded.data, revision = excluded.revision, updated_at = now();
  return jsonb_build_object('conflict', false, 'revision', next_revision);
end;
$$;
revoke all on function public.save_parity_ticket(text,jsonb,bigint) from public, anon, authenticated;
grant execute on function public.save_parity_ticket(text,jsonb,bigint) to service_role;
