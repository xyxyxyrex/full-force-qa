create table if not exists public.qa_annotation_statuses (
  site_slug text not null check (char_length(site_slug) between 1 and 100),
  master_id text not null check (char_length(master_id) between 1 and 100),
  item_number integer not null default 0 check (item_number >= 0),
  annotation_id text not null check (char_length(annotation_id) between 1 and 150),
  completed boolean not null default false,
  completed_by text not null default '' check (char_length(completed_by) <= 80),
  updated_at timestamptz not null default now(),
  primary key (site_slug, master_id, item_number, annotation_id)
);

create index if not exists qa_annotation_statuses_snapshot_idx
  on public.qa_annotation_statuses (site_slug, master_id, item_number);

alter table public.qa_annotation_statuses enable row level security;

grant select, insert, update on public.qa_annotation_statuses to anon, authenticated;

drop policy if exists "QA annotation statuses are publicly readable" on public.qa_annotation_statuses;
create policy "QA annotation statuses are publicly readable"
  on public.qa_annotation_statuses for select
  to anon, authenticated
  using (true);

drop policy if exists "QA annotation statuses can be created" on public.qa_annotation_statuses;
create policy "QA annotation statuses can be created"
  on public.qa_annotation_statuses for insert
  to anon, authenticated
  with check (
    exists (
      select 1
      from public.qa_snapshots snapshot
      where snapshot.site_slug = qa_annotation_statuses.site_slug
        and snapshot.master_id = qa_annotation_statuses.master_id
        and snapshot.item_number = qa_annotation_statuses.item_number
        and snapshot.expires_at > now()
    )
  );

drop policy if exists "QA annotation statuses can be updated" on public.qa_annotation_statuses;
create policy "QA annotation statuses can be updated"
  on public.qa_annotation_statuses for update
  to anon, authenticated
  using (
    exists (
      select 1
      from public.qa_snapshots snapshot
      where snapshot.site_slug = qa_annotation_statuses.site_slug
        and snapshot.master_id = qa_annotation_statuses.master_id
        and snapshot.item_number = qa_annotation_statuses.item_number
        and snapshot.expires_at > now()
    )
  )
  with check (
    exists (
      select 1
      from public.qa_snapshots snapshot
      where snapshot.site_slug = qa_annotation_statuses.site_slug
        and snapshot.master_id = qa_annotation_statuses.master_id
        and snapshot.item_number = qa_annotation_statuses.item_number
        and snapshot.expires_at > now()
    )
  );
