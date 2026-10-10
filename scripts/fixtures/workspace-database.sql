begin;
insert into auth.users(id) values('a0000000-0000-4000-8000-000000000001'),('b0000000-0000-4000-8000-000000000001');
select initialize_parity_account('a0000000-0000-4000-8000-000000000001','workspace-a@example.test','Workspace A',null);
select initialize_parity_account('b0000000-0000-4000-8000-000000000001','workspace-b@example.test','Workspace B',null);
insert into parity_projects(owner_key,project_id,data) values
('parity:a0000000-0000-4000-8000-000000000001','same-id','{"id":"same-id","name":"A private site","stagingUrl":"https://a.test/","createdAt":100,"lastOpenedAt":500,"workspaceData":{"annotations":[{"id":"keep-me"}]}}'),
('parity:b0000000-0000-4000-8000-000000000001','same-id','{"id":"same-id","name":"B private site","stagingUrl":"https://b.test/","createdAt":100}');
insert into parity_capture_activity values('parity:a0000000-0000-4000-8000-000000000001','a1111111-1111-4111-8111-111111111111','same-id','https://a.test/','electron',300);
insert into parity_notes(owner_key,note_id,data) values('parity:a0000000-0000-4000-8000-000000000001','deep-note',jsonb_build_object('id','deep-note','title','Deep note','plainText',repeat('prefix ',200)||'needle-in-body'));
do $$
declare owner text:='parity:a0000000-0000-4000-8000-000000000001'; s jsonb; r jsonb; rev bigint; result jsonb; repeated jsonb;
begin
  s:=parity_workspace_snapshot(owner); rev:=(s->>'revision')::bigint;
  if s::text like '%B private%' then raise exception 'Cross-account snapshot leak'; end if;
  if s::text like '%keep-me%' then raise exception 'Heavy workspace data should not be transmitted in catalog snapshots'; end if;
  r:=search_parity_workspace(owner,'needle-in-body',array['note'],null,null,'created',false,0,20);
  if jsonb_array_length(r->'records')<>1 or r#>>'{records,0,excerpt}' not like '%needle-in-body%' or length(r#>>'{records,0,excerpt}')>600 then raise exception 'Deep note search or bounded relevant excerpt failed'; end if;
  r:=search_parity_workspace(owner,'',array['capture'],200,400,'captured',false,0,20);
  if jsonb_array_length(r->'records')<>1 or r::text like '%B private%' then raise exception 'Capture date/owner filtering failed'; end if;
  r:=search_parity_workspace(owner,'',array['project'],200,400,'captured',false,0,20);
  if jsonb_array_length(r->'records')<>0 then raise exception 'Creation date substituted for capture date'; end if;
  r:=search_parity_workspace(owner,'private',array['project'],null,null,'created',false,0,1);
  if jsonb_array_length(r->'records')<>1 or r::text like '%B private%' then raise exception 'Cross-account search leak'; end if;
  result:=apply_parity_workspace_changes(owner,'a2222222-2222-4222-8222-222222222222','fixed-hash',rev,
    '[{"id":"folder-a","name":"Launch","createdAt":100}]','[{"id":"same-id","name":"A private site","stagingUrl":"https://a.test/","createdAt":100,"folderId":"folder-a"}]');
  if result#>>'{snapshot,projects,0,folderId}'<>'folder-a' then raise exception 'Transaction snapshot did not include committed writes'; end if;
  if (select data#>>'{workspaceData,annotations,0,id}' from parity_projects where owner_key=owner and project_id='same-id')<>'keep-me' then raise exception 'Organization mutation overwrote workspace annotations'; end if;
  repeated:=apply_parity_workspace_changes(owner,'a2222222-2222-4222-8222-222222222222','fixed-hash',rev,'[]','[]');
  if repeated<>result then raise exception 'Operation receipt was not idempotent'; end if;
  begin
    perform apply_parity_workspace_changes(owner,'a3333333-3333-4333-8333-333333333333','another',rev,'[]','[]');
    raise exception 'Expected stale revision rejection';
  exception when others then if sqlerrm not like '%workspace changed%' then raise; end if; end;
  begin
    perform apply_parity_workspace_changes(owner,'a2222222-2222-4222-8222-222222222222','different',rev,'[]','[]');
    raise exception 'Expected conflicting receipt rejection';
  exception when others then if sqlerrm not like '%different changes%' then raise; end if; end;
  if exists(select 1 from parity_workspace_operations where owner_key='parity:b0000000-0000-4000-8000-000000000001') then raise exception 'Receipt leaked to another account'; end if;
  if (select data->>'name' from parity_projects where owner_key='parity:b0000000-0000-4000-8000-000000000001' and project_id='same-id')<>'B private site' then raise exception 'Other account modified'; end if;
  if has_table_privilege('authenticated','parity_capture_activity','SELECT') or has_table_privilege('anon','parity_workspace_operations','SELECT') or has_function_privilege('authenticated','apply_parity_workspace_changes(text,uuid,text,bigint,jsonb,jsonb)','EXECUTE') then raise exception 'Privileged catalog API exposed to clients'; end if;
end $$;
rollback;
select 'PASS: private catalog search, accurate capture dates, transaction snapshots, revision conflicts, scoped operation receipts, and revoked direct access.';
