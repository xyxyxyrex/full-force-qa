do $$
declare
  cleanup_job_id bigint;
begin
  select jobid into cleanup_job_id from cron.job where jobname = 'qa-expired-assets-hourly' limit 1;
  if cleanup_job_id is not null then perform cron.unschedule(cleanup_job_id); end if;
end
$$;

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
      or (
        storage.allow_only_operation('object.delete')
        and (
          exists (
            select 1 from public.qa_snapshots snapshot
            where snapshot.object_path = name and snapshot.expires_at <= now()
          )
          or exists (
            select 1 from public.qa_snapshot_assets asset
            where asset.object_path = name and asset.expires_at <= now()
          )
        )
      )
    )
  );

drop policy if exists "QA expired snapshot objects can be deleted" on storage.objects;
create policy "QA expired snapshot objects can be deleted"
  on storage.objects for delete
  to anon, authenticated
  using (
    bucket_id = 'qa-ephemeral-snapshots'
    and (
      exists (
        select 1 from public.qa_snapshots snapshot
        where snapshot.object_path = name and snapshot.expires_at <= now()
      )
      or exists (
        select 1 from public.qa_snapshot_assets asset
        where asset.object_path = name and asset.expires_at <= now()
      )
    )
  );

create or replace function public.list_expired_qa_object_paths(batch_size integer default 100)
returns table(object_path text)
language sql
security definer
set search_path = public, storage
as $$
  select objects.name
  from storage.objects objects
  where objects.bucket_id = 'qa-ephemeral-snapshots'
    and (
      exists (
        select 1 from public.qa_snapshots snapshot
        where snapshot.object_path = objects.name and snapshot.expires_at <= now()
      )
      or exists (
        select 1 from public.qa_snapshot_assets asset
        where asset.object_path = objects.name and asset.expires_at <= now()
      )
    )
  order by objects.created_at
  limit least(greatest(coalesce(batch_size, 100), 1), 500);
$$;

create or replace function public.finalize_expired_qa_cleanup(object_paths text[])
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  removed_assets integer := 0;
  removed_snapshots integer := 0;
begin
  delete from public.qa_snapshot_assets asset
  where asset.expires_at <= now() and asset.object_path = any(coalesce(object_paths, array[]::text[]));
  get diagnostics removed_assets = row_count;

  delete from public.qa_snapshots snapshot
  where snapshot.expires_at <= now() and snapshot.object_path = any(coalesce(object_paths, array[]::text[]));
  get diagnostics removed_snapshots = row_count;

  delete from public.qa_annotation_comments comment
  where not exists (
    select 1 from public.qa_snapshots snapshot
    where snapshot.site_slug = comment.site_slug
      and snapshot.master_id = comment.master_id
      and snapshot.item_number = comment.item_number
      and snapshot.expires_at > now()
  );

  delete from public.qa_annotation_statuses status
  where not exists (
    select 1 from public.qa_snapshots snapshot
    where snapshot.site_slug = status.site_slug
      and snapshot.master_id = status.master_id
      and snapshot.item_number = status.item_number
      and snapshot.expires_at > now()
  );

  return jsonb_build_object('assets', removed_assets, 'snapshots', removed_snapshots);
end
$$;

revoke all on function public.list_expired_qa_object_paths(integer) from public;
revoke all on function public.finalize_expired_qa_cleanup(text[]) from public;
grant execute on function public.list_expired_qa_object_paths(integer) to anon, authenticated;
grant execute on function public.finalize_expired_qa_cleanup(text[]) to anon, authenticated;
