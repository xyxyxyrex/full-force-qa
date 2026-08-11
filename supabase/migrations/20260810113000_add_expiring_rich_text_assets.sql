alter table public.qa_snapshots
  drop constraint if exists qa_snapshots_notes_check;
alter table public.qa_snapshots
  add constraint qa_snapshots_notes_check check (char_length(notes) <= 50000);

alter table public.qa_annotation_comments
  drop constraint if exists qa_annotation_comments_body_check;
alter table public.qa_annotation_comments
  add constraint qa_annotation_comments_body_check
  check (char_length(trim(body)) between 1 and 50000);

create table if not exists public.qa_snapshot_assets (
  object_path text primary key check (char_length(object_path) between 1 and 1000),
  site_slug text not null check (char_length(site_slug) between 1 and 100),
  master_id text not null check (char_length(master_id) between 1 and 100),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (object_path like 'sites/%/assets/%')
);

create index if not exists qa_snapshot_assets_expiry_idx
  on public.qa_snapshot_assets (expires_at);
create index if not exists qa_snapshot_assets_capture_idx
  on public.qa_snapshot_assets (site_slug, master_id);

alter table public.qa_snapshot_assets enable row level security;
grant select, insert, update on public.qa_snapshot_assets to anon, authenticated;

drop policy if exists "QA rich assets are readable while active" on public.qa_snapshot_assets;
create policy "QA rich assets are readable while active"
  on public.qa_snapshot_assets for select
  to anon, authenticated
  using (expires_at > now());

drop policy if exists "QA rich assets can be registered" on public.qa_snapshot_assets;
create policy "QA rich assets can be registered"
  on public.qa_snapshot_assets for insert
  to anon, authenticated
  with check (
    expires_at > now()
    and object_path like ('sites/' || site_slug || '/' || master_id || '/assets/%')
  );

drop policy if exists "QA rich assets can be refreshed" on public.qa_snapshot_assets;
create policy "QA rich assets can be refreshed"
  on public.qa_snapshot_assets for update
  to anon, authenticated
  using (expires_at > now())
  with check (
    expires_at > now()
    and object_path like ('sites/' || site_slug || '/' || master_id || '/assets/%')
  );

drop policy if exists "QA comments are publicly readable" on public.qa_annotation_comments;
create policy "QA comments are publicly readable"
  on public.qa_annotation_comments for select
  to anon, authenticated
  using (
    exists (
      select 1
      from public.qa_snapshots snapshot
      where snapshot.site_slug = qa_annotation_comments.site_slug
        and snapshot.master_id = qa_annotation_comments.master_id
        and snapshot.item_number = qa_annotation_comments.item_number
        and snapshot.expires_at > now()
    )
  );

drop policy if exists "QA snapshot objects are readable" on storage.objects;
create policy "QA snapshot objects are readable"
  on storage.objects for select
  to anon, authenticated
  using (
    bucket_id = 'qa-ephemeral-snapshots'
    and (
      exists (
        select 1 from public.qa_snapshots snapshot
        where snapshot.object_path = name and snapshot.expires_at > now()
      )
      or exists (
        select 1 from public.qa_snapshot_assets asset
        where asset.object_path = name and asset.expires_at > now()
      )
    )
  );
