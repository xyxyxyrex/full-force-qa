do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'qa_annotation_statuses'
  ) then
    execute 'alter publication supabase_realtime add table public.qa_annotation_statuses';
  end if;

  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'qa_annotation_comments'
  ) then
    execute 'alter publication supabase_realtime add table public.qa_annotation_comments';
  end if;
end
$$;

comment on table public.qa_annotation_statuses is
  'Shared QA workflow statuses, published through Supabase Realtime for live viewers.';

comment on table public.qa_annotation_comments is
  'Shared QA discussion, published through Supabase Realtime for live viewers.';
