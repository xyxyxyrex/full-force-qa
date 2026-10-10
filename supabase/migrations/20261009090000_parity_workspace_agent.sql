-- Private catalog concurrency, reviewed-operation receipts, and actual capture dates.
create table public.parity_workspace_versions (
  owner_key text primary key references public.parity_accounts(owner_key) on delete cascade,
  revision bigint not null default 0
);
create table public.parity_workspace_operations (
  owner_key text not null references public.parity_accounts(owner_key) on delete cascade,
  operation_id uuid not null, request_hash text not null, result jsonb not null,
  created_at timestamptz not null default now(), primary key(owner_key,operation_id)
);
create table public.parity_capture_activity (
  owner_key text not null, event_id uuid not null, project_id text not null,
  url text not null check(length(url) <= 8000), engine text not null check(length(engine)<=40),
  completed_at bigint not null check(completed_at>0),
  primary key(owner_key,event_id),
  foreign key(owner_key,project_id) references public.parity_projects(owner_key,project_id) on delete cascade
);
create index parity_capture_activity_date_idx on public.parity_capture_activity(owner_key,completed_at desc);
create index parity_capture_activity_project_idx on public.parity_capture_activity(owner_key,project_id,completed_at desc);
alter table public.parity_workspace_versions enable row level security;
alter table public.parity_workspace_operations enable row level security;
alter table public.parity_capture_activity enable row level security;
revoke all on public.parity_workspace_versions,public.parity_workspace_operations,public.parity_capture_activity from public,anon,authenticated;
grant all on public.parity_workspace_versions,public.parity_workspace_operations,public.parity_capture_activity to service_role;

create function public.bump_parity_workspace_version() returns trigger language plpgsql security definer set search_path=public as $$
declare k text;
begin
  k:=case when TG_OP='DELETE' then old.owner_key else new.owner_key end;
  if TG_TABLE_NAME='parity_user_state' and TG_OP='UPDATE' and (new.data->'folders') is not distinct from (old.data->'folders') then return new; end if;
  perform pg_advisory_xact_lock(hashtextextended('parity-workspace:'||k,0));
  insert into parity_workspace_versions(owner_key,revision) values(k,1) on conflict(owner_key) do update set revision=parity_workspace_versions.revision+1;
  if TG_OP='DELETE' then return old; end if; return new;
end $$;
create trigger parity_projects_version before insert or update or delete on public.parity_projects for each row execute function public.bump_parity_workspace_version();
create trigger parity_folders_version before insert or update on public.parity_user_state for each row execute function public.bump_parity_workspace_version();

create function public.parity_workspace_snapshot(p_owner_key text) returns jsonb language sql security definer set search_path=public as $$
  select jsonb_build_object('revision',coalesce((select revision from parity_workspace_versions where owner_key=p_owner_key),0),
    'folders',coalesce((select data->'folders' from parity_user_state where owner_key=p_owner_key),'[]'::jsonb),
    'projects',coalesce((select jsonb_agg(data - 'workspaceData' - 'thumbnailUrl' - 'localOwnerKey' order by project_id) from parity_projects where owner_key=p_owner_key),'[]'::jsonb))
$$;
create function public.apply_parity_workspace_changes(p_owner_key text,p_operation_id uuid,p_request_hash text,p_revision bigint,p_folders jsonb,p_projects jsonb)
returns jsonb language plpgsql security definer set search_path=public as $$
declare prior parity_workspace_operations%rowtype; current_revision bigint; item jsonb; result jsonb;
begin
  perform pg_advisory_xact_lock(hashtextextended('parity-workspace:'||p_owner_key,0));
  select * into prior from parity_workspace_operations where owner_key=p_owner_key and operation_id=p_operation_id;
  if found then
    if prior.request_hash<>p_request_hash then raise exception 'Operation ID was already used for different changes'; end if;
    return prior.result;
  end if;
  select coalesce((select revision from parity_workspace_versions where owner_key=p_owner_key),0) into current_revision;
  if current_revision<>p_revision then raise exception 'The workspace changed. Request a refreshed preview before applying'; end if;
  if jsonb_typeof(p_folders)<>'array' or jsonb_typeof(p_projects)<>'array' or jsonb_array_length(p_projects)>10000 then raise exception 'Invalid workspace mutation'; end if;
  insert into parity_user_state(owner_key,data) values(p_owner_key,jsonb_build_object('folders',p_folders))
    on conflict(owner_key) do update set data=parity_user_state.data||excluded.data,updated_at=now();
  for item in select value from jsonb_array_elements(p_projects) loop
    insert into parity_projects(owner_key,project_id,data) values(p_owner_key,item->>'id',item)
      on conflict(owner_key,project_id) do update set data=(parity_projects.data - 'folderId' - 'deletedAt')||excluded.data,updated_at=now();
  end loop;
  result:=jsonb_build_object('snapshot',parity_workspace_snapshot(p_owner_key));
  insert into parity_workspace_operations(owner_key,operation_id,request_hash,result) values(p_owner_key,p_operation_id,p_request_hash,result);
  return result;
end $$;

-- Parameters stay data; search never interpolates model text into SQL or owner filters.
create function public.search_parity_workspace(p_owner_key text,p_query text,p_kinds text[],p_from bigint,p_to bigint,p_date_field text,p_include_trash boolean,p_offset integer,p_limit integer)
returns jsonb language sql security definer set search_path=public stable as $$
with records as (
 select 'project'::text kind,project_id id,data->>'name' title,data->>'stagingUrl' url,
   ''::text excerpt,data->>'folderId' folder_id,project_id project_id,
   case when data->>'createdAt' ~ '^\d{1,16}$' then (data->>'createdAt')::bigint end created,
   null::bigint captured,case when data->>'lastOpenedAt' ~ '^\d{1,16}$' then (data->>'lastOpenedAt')::bigint end opened,
   (data->>'inTrash')='true' trash,(extract(epoch from updated_at)*1000)::bigint modified from parity_projects where owner_key=p_owner_key
 union all select 'note',note_id,data->>'title',null,coalesce(data->>'plainText',''),null,null,
   case when data->>'createdAt' ~ '^\d{1,16}$' then (data->>'createdAt')::bigint end,null,null,false,(extract(epoch from updated_at)*1000)::bigint from parity_notes where owner_key=p_owner_key
 union all select 'ticket',ticket_id,data->>'title',data#>>'{source,url}',coalesce(data->>'description',''),null,null,
   case when data->>'createdAt' ~ '^\d{1,16}$' then (data->>'createdAt')::bigint end,null,null,false,(extract(epoch from updated_at)*1000)::bigint from parity_tickets where owner_key=p_owner_key
 union all select 'folder',f->>'id',f->>'name',null,'',f->>'parentId',null,
   case when f->>'createdAt' ~ '^\d{1,16}$' then (f->>'createdAt')::bigint end,null,null,false,(extract(epoch from s.updated_at)*1000)::bigint from parity_user_state s cross join lateral jsonb_array_elements(coalesce(s.data->'folders','[]'::jsonb)) f where s.owner_key=p_owner_key
 union all select 'capture',a.event_id::text,p.data->>'name',a.url,a.engine||' capture',p.data->>'folderId',a.project_id,null,a.completed_at,null,(p.data->>'inTrash')='true',a.completed_at
   from parity_capture_activity a join parity_projects p on p.owner_key=a.owner_key and p.project_id=a.project_id where a.owner_key=p_owner_key
), filtered as (
 select *,case p_date_field when 'captured' then captured when 'opened' then opened else created end stamp from records
 where (cardinality(p_kinds)=0 or kind=any(p_kinds)) and (p_include_trash or not coalesce(trash,false))
   and not exists(select 1 from regexp_split_to_table(lower(coalesce(p_query,'')),'\s+') term where term<>'' and position(term in lower(id||' '||coalesce(title,'')||' '||coalesce(url,'')||' '||coalesce(excerpt,'')))=0)
), page as (
 select * from filtered where (p_from is null or stamp>=p_from) and (p_to is null or stamp<p_to)
 order by stamp desc nulls last,kind,id offset greatest(0,p_offset) limit least(50,greatest(1,p_limit))+1
), items as (
 select jsonb_build_object('kind',kind,'id',id,'title',coalesce(title,'Untitled'),'url',url,'excerpt',substring(excerpt from greatest(1,position(lower(split_part(p_query,' ',1)) in lower(excerpt))-80) for 600),'folderId',folder_id,'projectId',project_id,'createdAt',created,'capturedAt',captured,'openedAt',opened,'updatedAt',modified,'inTrash',coalesce(trash,false),'source','cloud') value,row_number() over() n from page
)
select jsonb_build_object('records',coalesce((select jsonb_agg(value order by n) from items where n<=least(50,greatest(1,p_limit))),'[]'::jsonb),
 'nextOffset',case when (select count(*) from items)>least(50,greatest(1,p_limit)) then greatest(0,p_offset)+least(50,greatest(1,p_limit)) else null end)
$$;
revoke all on function public.bump_parity_workspace_version() from public,anon,authenticated;
revoke all on function public.parity_workspace_snapshot(text) from public,anon,authenticated;
revoke all on function public.apply_parity_workspace_changes(text,uuid,text,bigint,jsonb,jsonb) from public,anon,authenticated;
revoke all on function public.search_parity_workspace(text,text,text[],bigint,bigint,text,boolean,integer,integer) from public,anon,authenticated;
grant execute on function public.parity_workspace_snapshot(text),public.apply_parity_workspace_changes(text,uuid,text,bigint,jsonb,jsonb),public.search_parity_workspace(text,text,text[],bigint,bigint,text,boolean,integer,integer) to service_role;
