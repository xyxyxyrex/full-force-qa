alter table public.qa_annotation_statuses
  add column if not exists status text;

update public.qa_annotation_statuses
set status = case when completed then 'completed' else 'requested' end
where status is null;

alter table public.qa_annotation_statuses
  alter column status set default 'requested',
  alter column status set not null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'qa_annotation_statuses_status_check'
      and conrelid = 'public.qa_annotation_statuses'::regclass
  ) then
    alter table public.qa_annotation_statuses
      add constraint qa_annotation_statuses_status_check
      check (status in (
        'requested',
        'in_progress',
        'completed',
        'rejected',
        'approved',
        'invalid',
        'enhancement',
        'pm_clarification'
      ));
  end if;
end
$$;

comment on column public.qa_annotation_statuses.status is
  'Shared annotation workflow status. Requested is the default; completed mirrors legacy Done records.';
