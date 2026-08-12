alter table public.qa_snapshots
  add column if not exists annotation_sequences jsonb not null default '[]'::jsonb;

alter table public.qa_snapshots
  drop constraint if exists qa_snapshots_annotation_sequences_is_array;

alter table public.qa_snapshots
  add constraint qa_snapshots_annotation_sequences_is_array
  check (jsonb_typeof(annotation_sequences) = 'array');

create index if not exists qa_snapshots_annotation_sequences_idx
  on public.qa_snapshots using gin (annotation_sequences);

comment on column public.qa_snapshots.annotation_sequences is
  'Ordered annotation sequences. Each entry contains parentAnnotationId and annotationIds, with the parent first.';
